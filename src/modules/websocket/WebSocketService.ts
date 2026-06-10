import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { redis } from '../../config/redis';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { eventBus } from '../../core/events/DomainEventBus';
import { logger } from '../../infrastructure/logger/Logger';
import { WS_CONSTANTS } from './constants';
import type { AppDomainEvent } from '../../core/events/events';

interface ExtendedWebSocket extends WebSocket {
  projectId?: string;
  userId?: string;
  isAlive?: boolean;
}

/**
 * WebSocket real-time service.
 * - Rooms are keyed by projectId; each connection joins one room.
 * - Presence is tracked in Redis Hash (projectId → JSON of connected users).
 * - Domain events are forwarded to all room members.
 * - A 30-second event replay buffer (Redis Sorted Set, keyed by timestamp) is
 *   sent to reconnecting clients that pass `?since=<unixMs>` on connect.
 */
export class WebSocketService {
  private readonly wss: WebSocketServer;
  /** Map from projectId to the set of live sockets subscribed to that room */
  private readonly rooms = new Map<string, Set<ExtendedWebSocket>>();
  private readonly pingInterval: NodeJS.Timeout;

  constructor(server: import('http').Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws as ExtendedWebSocket, req));

    // Subscribe to all domain events and broadcast to the relevant project room
    eventBus.subscribe<AppDomainEvent>('*', async (event) => {
      const projectId = this.extractProjectId(event);
      if (projectId) {
        await this.broadcastToRoom(projectId, event);
        await this.appendToReplayBuffer(projectId, event);
      }
    });

    // Heartbeat: drop stale connections every PING_INTERVAL_MS
    this.pingInterval = setInterval(() => this.heartbeat(), WS_CONSTANTS.PING_INTERVAL_MS);

    logger.info('WebSocketService started on path /ws');
  }

  /** Handle a new incoming WebSocket connection */
  private onConnection(ws: ExtendedWebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '', 'ws://localhost');
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const userId    = url.searchParams.get('userId')    ?? undefined;
    const since     = url.searchParams.get('since');

    ws.projectId = projectId;
    ws.userId    = userId;
    ws.isAlive   = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => this.onDisconnect(ws));
    ws.on('error', (err) => logger.warn({ err, userId, projectId }, 'WebSocket error'));

    if (projectId) {
      if (!this.rooms.has(projectId)) this.rooms.set(projectId, new Set());
      this.rooms.get(projectId)!.add(ws);
      void this.trackPresence(projectId, userId);

      // Replay missed events if client passes ?since=<unixMs>
      if (since) void this.replayEvents(ws, projectId, Number(since));
    }

    logger.debug({ userId, projectId }, 'WebSocket client connected');
  }

  /** Clean up room membership and presence when a client disconnects */
  private onDisconnect(ws: ExtendedWebSocket): void {
    const { projectId, userId } = ws;
    if (projectId) {
      const room = this.rooms.get(projectId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) this.rooms.delete(projectId);
      }
      void this.untrackPresence(projectId, userId);
    }
    logger.debug({ userId, projectId }, 'WebSocket client disconnected');
  }

  /** Broadcast an event payload to all sockets in a project room */
  private async broadcastToRoom(projectId: string, event: AppDomainEvent): Promise<void> {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const payload = JSON.stringify(event);
    for (const client of room) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Append an event to the Redis Sorted Set replay buffer (score = unix ms) */
  private async appendToReplayBuffer(projectId: string, event: AppDomainEvent): Promise<void> {
    const key   = CacheKeys.events(projectId);
    const score = Date.now();
    await redis.zadd(key, score, JSON.stringify(event));
    // Trim to keep only events within the replay window
    const cutoff = score - WS_CONSTANTS.REPLAY_WINDOW_SECONDS * 1000;
    await redis.zremrangebyscore(key, '-inf', cutoff);
    // Hard cap to prevent unbounded growth
    await redis.zremrangebyrank(key, 0, -(WS_CONSTANTS.REPLAY_BUFFER_MAX_ITEMS + 1));
  }

  /** Send buffered events since `sinceMs` to a reconnecting client */
  private async replayEvents(ws: ExtendedWebSocket, projectId: string, sinceMs: number): Promise<void> {
    const key    = CacheKeys.events(projectId);
    const events = await redis.zrangebyscore(key, sinceMs + 1, '+inf');
    for (const raw of events) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  /** Track a connected user in the Redis presence Hash for this project */
  private async trackPresence(projectId: string, userId?: string): Promise<void> {
    if (!userId) return;
    const key = CacheKeys.presence(projectId);
    await redis.hset(key, userId, Date.now().toString());
    await redis.expire(key, WS_CONSTANTS.PRESENCE_TTL_SECONDS);
  }

  /** Remove a user from the Redis presence Hash */
  private async untrackPresence(projectId: string, userId?: string): Promise<void> {
    if (!userId) return;
    await redis.hdel(CacheKeys.presence(projectId), userId);
  }

  /** Extract the projectId from domain event payload (all events carry it) */
  private extractProjectId(event: AppDomainEvent): string | null {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload['projectId'] === 'string' ? payload['projectId'] : null;
  }

  /** Ping all clients; terminate those that missed the last ping */
  private heartbeat(): void {
    for (const [, room] of this.rooms) {
      for (const ws of room) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }

  /** Gracefully close the server and clear the ping interval */
  close(): Promise<void> {
    clearInterval(this.pingInterval);
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  /** Return count of currently connected clients across all rooms */
  get clientCount(): number {
    let count = 0;
    for (const [, room] of this.rooms) count += room.size;
    return count;
  }
}
