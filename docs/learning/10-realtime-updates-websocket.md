# Real-Time Updates — WebSocket

## What You'll Learn

- The difference between HTTP polling, long-polling, Server-Sent Events, and WebSockets — and when to choose each
- How the WebSocket handshake upgrades an HTTP connection to a persistent bidirectional channel
- What a "room" (or channel) is and how the in-memory room registry works in this codebase
- How `WebSocketService` connects to `DomainEventBus` to fan out domain events to every interested browser tab
- How the replay buffer and presence tracking work using Redis
- The challenges of scaling WebSockets across multiple server pods, and how Redis Pub/Sub solves them
- The full data-flow from a developer editing an issue to every collaborator's board updating live

---

## Theory

### 1. The Four Patterns for Real-Time Data Delivery

Before reaching for WebSockets, it helps to understand the full spectrum of options and where each sits on the trade-off curve.

#### HTTP Polling

The client asks the server "anything new?" on a fixed interval — every 5 seconds, every 30 seconds, whatever. The server always responds immediately, even if the answer is "no."

```typescript
// Pseudocode — classic polling
setInterval(async () => {
  const updates = await fetch('/api/board/updates?since=' + lastTimestamp);
  applyUpdates(await updates.json());
}, 5000);
```

**Pros:** dead simple, works through every proxy and firewall, stateless server.  
**Cons:** wasteful — the majority of responses are empty. Latency is bounded by the poll interval, not by when data actually changes. Under heavy load, many clients polling frequently can saturate the server.

#### Long-Polling

A refinement: the client opens a request and the server *holds* it open until it has something to send (or a timeout expires). Once the client receives a response it immediately opens another request.

```typescript
// Pseudocode — long-polling
async function longPoll() {
  const res = await fetch('/api/events/wait?timeout=30');
  processEvent(await res.json());
  longPoll(); // re-open immediately
}
longPoll();
```

**Pros:** much lower latency than polling; still stateless from the perspective of connection overhead at the load balancer.  
**Cons:** every "event" still pays full HTTP overhead (headers, TLS handshake amortisation, connection setup). The server must hold threads or file descriptors open for each waiting request.

#### Server-Sent Events (SSE)

The server opens a single unidirectional HTTP/1.1 or HTTP/2 stream. Data flows server → client only. The browser's built-in `EventSource` API handles reconnection automatically.

```typescript
// Server (Node.js/Koa pseudocode)
ctx.set('Content-Type', 'text/event-stream');
ctx.set('Cache-Control', 'no-cache');
ctx.body = new PassThrough();
ctx.body.write('data: {"type":"IssueUpdated","id":"42"}\n\n');

// Client
const es = new EventSource('/api/events?projectId=proj-1');
es.onmessage = (e) => applyUpdate(JSON.parse(e.data));
```

**Pros:** simple protocol, built-in browser reconnection with `Last-Event-ID`, works over HTTP/2 multiplexing so the 6-connections-per-domain browser limit does not apply.  
**Cons:** server → client only. If the client needs to send messages back (cursor position, collaborative editing ACKs), you need a separate HTTP channel.

#### WebSockets

A full-duplex persistent channel. After a one-time HTTP upgrade handshake, both sides can send frames at any time with minimal overhead (2–10 bytes of framing per message vs hundreds of bytes of HTTP headers per polling request).

```
Client                     Server
  |------ HTTP GET /ws -------->|   (upgrade request)
  |<-- 101 Switching Protocols--|   (upgrade accepted)
  |<======= WS frame  ========>|   (bidirectional, persistent)
  |<======= WS frame  ========>|
```

**Pros:** lowest latency, bidirectional, very low per-message overhead after the initial handshake.  
**Cons:** stateful — the connection is tied to a specific server process. This complicates horizontal scaling (covered below). Also harder to cache or inspect through standard HTTP infrastructure.

**Decision guide:**

| Situation | Choose |
|---|---|
| Data changes rarely, small user base | HTTP polling |
| Near-real-time notifications, client only reads | SSE |
| Collaborative editing, live cursors, chat | WebSocket |
| Dashboards that refresh on a cadence | HTTP polling or SSE |
| This codebase (board updates, sprint events) | WebSocket |

---

### 2. The WebSocket Handshake — HTTP Upgrade

WebSocket connections start life as plain HTTP requests. The client sends a `GET` with special headers:

```http
GET /ws?projectId=proj-abc&userId=user-123 HTTP/1.1
Host: app.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

The server accepts by responding `101 Switching Protocols`:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

The `Sec-WebSocket-Accept` value is derived from the client's `Sec-WebSocket-Key` plus a magic GUID, preventing accidental acceptance by non-WebSocket servers. After the `101` response, the TCP socket is "stolen" from the HTTP layer — from this point forward, both sides exchange compact binary frames instead of HTTP messages.

The Node.js `ws` library handles all of this automatically when you create a `WebSocketServer` — you never write the handshake by hand.

---

### 3. Rooms (Channels): Organising Connections by Context

Without rooms, every broadcast goes to every connected client. On a board application that is both wasteful and incorrect — a developer working on Project A should not receive events about Project B.

A "room" is simply a named group of connections. Think of it as a multicast mailing list: joining a room is subscribing, and broadcasting to a room delivers to all current subscribers.

```typescript
// Pseudocode — generic room pattern
const rooms = new Map<string, Set<WebSocket>>();

function joinRoom(ws: WebSocket, roomId: string) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(ws);
}

function broadcastToRoom(roomId: string, data: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const client of room) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function leaveRoom(ws: WebSocket, roomId: string) {
  rooms.get(roomId)?.delete(ws);
}
```

In this codebase, rooms are keyed by `projectId`. Every `WebSocket` connection carries the project it belongs to, and the `WebSocketService` routes events only to the matching project room.

---

### 4. Scaling WebSockets: Sticky Sessions and Redis Pub/Sub

#### The Problem with Multiple Pods

On a single server process, the in-memory room map works perfectly. The moment you scale to multiple pods (e.g., three replicas behind a load balancer), you have a split-brain problem:

```
Load Balancer
├── Pod A  — rooms: { "proj-1": [Alice, Bob] }
├── Pod B  — rooms: { "proj-1": [Carol] }
└── Pod C  — rooms: { "proj-1": [] }
```

If an issue update arrives at Pod A (because Alice made the change), Alice and Bob receive the event — but Carol on Pod B never does. The room registries are completely isolated.

#### Sticky Sessions (Partial Solution)

A load balancer can use sticky sessions (also called session affinity) to route all WebSocket connections for a given client to the same pod, using a cookie or IP hash. This prevents the split-brain for any single client but does not solve fan-out: Pod A still cannot reach Carol on Pod B.

#### Redis Pub/Sub (The Full Solution)

Redis has a built-in Pub/Sub mechanism. Each pod subscribes to a Redis channel. When a pod receives a domain event it wants to broadcast, it publishes to Redis *instead of* (or in addition to) broadcasting locally. All pods receive the published message and broadcast to their local room members.

```typescript
// Pseudocode — multi-pod fan-out via Redis Pub/Sub
// Each pod runs this at startup:
redis.subscribe(`project:${projectId}`, (message) => {
  broadcastLocalRoom(projectId, message); // deliver to sockets on THIS pod
});

// When a domain event fires on any pod:
async function onDomainEvent(projectId: string, event: AppDomainEvent) {
  await redis.publish(`project:${projectId}`, JSON.stringify(event));
  // Redis fans it out to all pods; each pod broadcasts to its own sockets
}
```

**The current implementation in this codebase does not implement Redis Pub/Sub fan-out.** It operates on the assumption of a single-process deployment. Broadcasting is entirely in-memory (`broadcastToRoom` in `WebSocketService.ts`). Adding Redis Pub/Sub would be the required next step before running more than one server replica.

---

### 5. `ws` vs Socket.io

The `ws` package is a minimal, spec-compliant WebSocket implementation for Node.js. It does exactly what the WebSocket RFC specifies and nothing more.

Socket.io is a higher-level abstraction that wraps `ws` (and falls back to long-polling when WebSockets are unavailable) and adds:

- Named events (instead of raw string messages)
- Automatic reconnection with exponential backoff
- Room and namespace abstractions built in
- Acknowledgements (request/response over WebSocket)
- Adapter system for Redis Pub/Sub fan-out (the `socket.io-redis` adapter)

This codebase uses `ws` directly. This is a deliberate, lightweight choice — it avoids the overhead and magic of Socket.io when you control both ends of the connection. The trade-off is that you must implement reconnection logic, room management, and event replay yourself (which this codebase does, as you will see below).

---

### 6. Connection State and Client-Side Reconnection

A WebSocket connection can be in one of four `readyState` values:

| State | Value | Meaning |
|---|---|---|
| `CONNECTING` | `0` | Handshake in progress |
| `OPEN` | `1` | Connected and usable |
| `CLOSING` | `2` | Close handshake initiated |
| `CLOSED` | `3` | Connection terminated |

Networks are unreliable. Pods restart. Load balancers kill idle connections. A robust client must reconnect automatically when the connection closes unexpectedly:

```typescript
// Pseudocode — client-side reconnection with exponential backoff
function connect(projectId: string, userId: string, lastEventTime: number) {
  const url = `/ws?projectId=${projectId}&userId=${userId}&since=${lastEventTime}`;
  const ws = new WebSocket(url);

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    lastEventTime = Date.now();
    applyBoardUpdate(event);
  };

  ws.onclose = () => {
    const delay = Math.min(1000 * 2 ** retryCount, 30_000); // cap at 30s
    retryCount++;
    setTimeout(() => connect(projectId, userId, lastEventTime), delay);
  };

  ws.onopen = () => { retryCount = 0; };
}
```

The `?since=<unixMs>` parameter is how the client tells the server "I was last connected at time T — please replay anything I missed." This is exactly what the replay buffer in `WebSocketService` serves.

---

## Implementation Walkthrough

### 1. Attaching the WebSocket Server to the HTTP Server (`server.ts`)

Koa does not speak WebSocket natively — it handles HTTP. The trick is that `ws` attaches to the underlying Node.js `http.Server`, not to Koa. Both protocols share the same TCP port. When an `Upgrade: websocket` request arrives, Node's HTTP server hands it to the `WebSocketServer`; all other requests continue to Koa.

```typescript
// src/server.ts  lines 36-39
const app = createApp();
const httpServer = createServer(app.callback());

// Wire up WebSocket real-time service
const wsService = new WebSocketService(httpServer);
```

`createApp()` returns the Koa `Application`. `createServer(app.callback())` wraps it in a plain `http.Server`. `new WebSocketService(httpServer)` passes that same `http.Server` into the `WebSocketServer` constructor, where it registers an `upgrade` event listener to intercept WebSocket handshakes. After this, `httpServer.listen(env.PORT, ...)` starts a single listener on one port that serves both HTTP and WebSocket traffic simultaneously.

The `WebSocketService` is also stored in `wsService` so it can be cleanly closed during graceful shutdown (lines 77–79):

```typescript
// src/server.ts  lines 77-79
sqsConsumer?.stop();
await wsService.close();
await AppDataSource.destroy();
```

---

### 2. `WebSocketService` — Construction and Domain Event Subscription

```typescript
// src/modules/websocket/WebSocketService.ts  lines 30-47
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
```

Three things happen at construction time:

1. A `WebSocketServer` is created on path `/ws`, attached to the shared HTTP server. All WebSocket connections must target `ws://host/ws`.
2. `eventBus.subscribe('*', ...)` registers a wildcard handler that will fire for *every* domain event published anywhere in the application. The wildcard (`'*'`) is emitted by `DomainEventBus.publish()` in addition to the specific event type (see `DomainEventBus.ts` line 10: `this.emit('*', event)`).
3. A `setInterval` starts the heartbeat loop, which runs every 25 seconds (`WS_CONSTANTS.PING_INTERVAL_MS = 25_000`).

---

### 3. The `ExtendedWebSocket` Interface — Per-Connection Metadata

```typescript
// src/modules/websocket/WebSocketService.ts  lines 10-14
interface ExtendedWebSocket extends WebSocket {
  projectId?: string;
  userId?: string;
  isAlive?: boolean;
}
```

The `ws` library gives you a plain `WebSocket` object. By extending it with `projectId`, `userId`, and `isAlive`, the service can store connection-specific state directly on the socket object. This avoids maintaining a separate `Map<WebSocket, Metadata>` and keeps the disconnect handler simple — it just reads `ws.projectId` and `ws.userId` directly.

---

### 4. Connection Handling — How a Client Joins a Room

A client connects by opening a WebSocket to the path with query parameters:

```
ws://localhost:3000/ws?projectId=proj-abc123&userId=user-xyz789&since=1749600000000
```

The `since` parameter is optional and only provided on reconnection.

```typescript
// src/modules/websocket/WebSocketService.ts  lines 50-73
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
```

Step by step:

1. `projectId` and `userId` are parsed from the URL query string and stored on `ws`.
2. `ws.isAlive = true` initialises the heartbeat liveness flag.
3. A `pong` handler resets `isAlive` — this is how the heartbeat confirms the connection is alive (see section 8 below).
4. If `projectId` is present, the socket is added to the in-memory room: `this.rooms.get(projectId)!.add(ws)`.
5. `trackPresence` writes the user to a Redis Hash so other services can query who is currently online for a project.
6. If `since` is provided, `replayEvents` fetches and replays up to 30 seconds of buffered events from Redis.

Note: there is no token-based authentication at the WebSocket layer in this implementation. The `userId` is trusted as-is from the query string. Production systems typically validate a short-lived JWT at connection time.

---

### 5. The Room Registry — `Map<projectId, Set<ExtendedWebSocket>>`

```typescript
// src/modules/websocket/WebSocketService.ts  line 27
private readonly rooms = new Map<string, Set<ExtendedWebSocket>>();
```

This is the heart of the room system. The outer `Map` keys on `projectId`. The inner `Set` holds all currently open sockets subscribed to that project.

Visual representation with two projects and four connected clients:

```
rooms (Map)
├── "proj-abc123"  →  Set { ws_alice, ws_bob }
└── "proj-xyz789"  →  Set { ws_carol, ws_dave }
```

When `broadcastToRoom("proj-abc123", event)` is called, only `ws_alice` and `ws_bob` receive the message. Carol and Dave are unaffected.

---

### 6. Broadcasting to a Room

```typescript
// src/modules/websocket/WebSocketService.ts  lines 91-99
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
```

The entire `AppDomainEvent` object is serialised to JSON and sent as a single WebSocket text frame to each OPEN client. The `readyState` guard is important — a socket in `CLOSING` or `CLOSED` state must not be written to, or the `ws` library will throw.

The broadcast payload shape is exactly the domain event. For example, when an issue is updated:

```json
{
  "type": "IssueUpdated",
  "occurredAt": "2026-06-12T09:00:00.000Z",
  "correlationId": "corr-00112233",
  "payload": {
    "issueId": "issue-789",
    "projectId": "proj-abc123",
    "changes": { "title": "New Title", "storyPoints": 5 },
    "actorId": "user-xyz789"
  }
}
```

The client reads `event.type` to decide how to handle the message. No envelope wrapping or extra protocol overhead is added.

---

### 7. Domain Events Carried by the Bus

Every event that can reach the WebSocket layer is defined in `events.ts`. Each interface extends `DomainEvent` (which supplies `type`, `occurredAt`, and `correlationId`) and adds a `payload` specific to that event.

```typescript
// src/core/events/events.ts  lines 1-37
export interface IssueCreatedEvent extends DomainEvent {
  readonly type: 'IssueCreated';
  readonly payload: { issueId: string; projectId: string; actorId: string };
}
export interface StatusChangedEvent extends DomainEvent {
  readonly type: 'StatusChanged';
  readonly payload: {
    issueId: string; projectId: string;
    fromStatusId: string; toStatusId: string; actorId: string;
  };
}
export interface IssueUpdatedEvent extends DomainEvent {
  readonly type: 'IssueUpdated';
  readonly payload: { issueId: string; projectId: string; changes: Record<string, unknown>; actorId: string };
}
export interface IssueMovedEvent extends DomainEvent {
  readonly type: 'IssueMoved';
  readonly payload: {
    issueId: string; projectId: string;
    fromSprintId: string | null; toSprintId: string | null; actorId: string;
  };
}
export interface CommentAddedEvent extends DomainEvent {
  readonly type: 'CommentAdded';
  readonly payload: { commentId: string; issueId: string; projectId: string; authorId: string; mentions: string[] };
}
export interface SprintUpdatedEvent extends DomainEvent {
  readonly type: 'SprintUpdated';
  readonly payload: { sprintId: string; projectId: string; actorId: string };
}

export type AppDomainEvent =
  | IssueCreatedEvent | StatusChangedEvent | IssueUpdatedEvent
  | IssueMovedEvent | CommentAddedEvent | SprintUpdatedEvent;
```

Every event's `payload` includes `projectId`. This is the contract that `extractProjectId` relies on:

```typescript
// src/modules/websocket/WebSocketService.ts  lines 138-141
private extractProjectId(event: AppDomainEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload['projectId'] === 'string' ? payload['projectId'] : null;
}
```

---

### 8. Heartbeat — Detecting Dead Connections

TCP connections can appear open at the OS level even after the remote end has silently disappeared (network partition, laptop sleep, NAT timeout). Without heartbeating, the room registry would accumulate ghost sockets and `client.send()` would silently fail or throw.

The WebSocket protocol has a built-in ping/pong mechanism. The server sends a `ping` frame; the client's WebSocket implementation automatically responds with a `pong` frame. If no pong arrives before the next ping cycle, the connection is considered dead.

```typescript
// src/modules/websocket/WebSocketService.ts  lines 144-152
private heartbeat(): void {
  for (const [, room] of this.rooms) {
    for (const ws of room) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}
```

The cycle works as follows:

1. Every 25 seconds (`PING_INTERVAL_MS = 25_000`), `heartbeat()` runs.
2. For each socket: if `isAlive` is already `false` (meaning no pong was received since the last ping), the socket is forcibly terminated with `ws.terminate()`.
3. Otherwise, `isAlive` is set to `false` and a `ping` is sent.
4. When the client's pong arrives, the `pong` event handler (registered in `onConnection`) sets `isAlive = true` again.

This gives each client a window of 25 seconds to respond before being dropped. `HEARTBEAT_TIMEOUT_MS = 35_000` in constants is the complementary value a client-side implementation would use to detect a stale server-side connection.

---

### 9. Disconnect Cleanup — Removing Sockets from Rooms

```typescript
// src/modules/websocket/WebSocketService.ts  lines 77-88
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
```

Two cleanup actions happen:

1. **Room cleanup:** The socket is removed from its project's `Set`. If the `Set` is now empty, the entire room entry is deleted from the `Map` to avoid an ever-growing map of empty sets.
2. **Presence cleanup:** `untrackPresence` deletes the user's field from the Redis presence Hash (`HDEL`), so any API endpoint querying online users for this project will no longer see them.

---

### 10. The Replay Buffer — Catching Up After Reconnection

Reconnecting clients may have missed events during the gap. The service maintains a short-term event buffer per project in Redis, using a Sorted Set (ZSET) where the score is the Unix timestamp in milliseconds.

```typescript
// src/modules/websocket/WebSocketService.ts  lines 103-111
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
```

After every broadcast, the event is also written to Redis with `ZADD`. Then two cleanup operations run:

- `ZREMRANGEBYSCORE -inf <cutoff>` removes events older than 30 seconds (`REPLAY_WINDOW_SECONDS = 30`).
- `ZREMRANGEBYRANK 0 -(101)` hard-caps the set at 100 events (`REPLAY_BUFFER_MAX_ITEMS = 100`) to prevent a pathological burst from consuming unbounded memory.

Replay on reconnection:

```typescript
// src/modules/websocket/WebSocketService.ts  lines 115-121
private async replayEvents(ws: ExtendedWebSocket, projectId: string, sinceMs: number): Promise<void> {
  const key    = CacheKeys.events(projectId);
  const events = await redis.zrangebyscore(key, sinceMs + 1, '+inf');
  for (const raw of events) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}
```

`ZRANGEBYSCORE key (sinceMs +inf` retrieves all events with a score strictly greater than `sinceMs`. The `+ 1` ensures the event at exactly `sinceMs` (already seen) is excluded. Each event is sent as a raw JSON string directly — no re-serialisation needed since the buffer stores pre-serialised payloads.

---

### 11. Presence Tracking

```typescript
// src/modules/websocket/WebSocketService.ts  lines 124-135
private async trackPresence(projectId: string, userId?: string): Promise<void> {
  if (!userId) return;
  const key = CacheKeys.presence(projectId);
  await redis.hset(key, userId, Date.now().toString());
  await redis.expire(key, WS_CONSTANTS.PRESENCE_TTL_SECONDS);
}

private async untrackPresence(projectId: string, userId?: string): Promise<void> {
  if (!userId) return;
  await redis.hdel(CacheKeys.presence(projectId), userId);
}
```

A Redis Hash at `CacheKeys.presence(projectId)` maps `userId` → `connectedAtTimestamp`. The entire Hash expires after 300 seconds (`PRESENCE_TTL_SECONDS = 300`) as a safety net against crash scenarios where `untrackPresence` never runs. Any service can call `HGETALL presence:<projectId>` to get the current set of online users for a project.

---

### 12. Configuration Constants

```typescript
// src/modules/websocket/constants.ts
export const WS_CONSTANTS = {
  PRESENCE_TTL_SECONDS:    300,   // Presence Hash TTL — 5 minutes
  REPLAY_WINDOW_SECONDS:   30,    // How far back the replay buffer covers
  REPLAY_BUFFER_MAX_ITEMS: 100,   // Hard cap on events per project in Redis
  PING_INTERVAL_MS:        25_000, // How often the server pings clients
  HEARTBEAT_TIMEOUT_MS:    35_000, // Client-side complement — detect dead server
} as const;
```

All tuneable values are centralised here rather than scattered as magic numbers throughout `WebSocketService`. This follows the project's code-style convention of using constants files for this purpose.

---

### 13. The Full Data-Flow: Issue Update to Live Board

Here is the complete path from a developer's API call to every connected browser tab receiving the update.

```
Developer's browser
  │
  │  PUT /api/issues/issue-789  { title: "New Title" }
  │
  ▼
Koa HTTP Router
  │
  ▼
IssueCommandService.updateIssue()
  │  (validates, persists to PostgreSQL via TypeORM)
  │
  │  eventBus.publish({
  │    type: 'IssueUpdated',
  │    occurredAt: new Date(),
  │    correlationId: 'corr-00112233',
  │    payload: {
  │      issueId: 'issue-789',
  │      projectId: 'proj-abc123',
  │      changes: { title: 'New Title' },
  │      actorId: 'user-xyz789'
  │    }
  │  })
  │
  ▼
DomainEventBus (EventEmitter)
  │
  │  emit('IssueUpdated', event)  ─── ActivityService receives it
  │  emit('*', event)             ─── WebSocketService receives it
  │
  ▼
WebSocketService.broadcastToRoom('proj-abc123', event)
  │
  │  rooms.get('proj-abc123')
  │    └── Set { ws_alice, ws_bob }
  │
  │  ws_alice.send(JSON.stringify(event))
  │  ws_bob.send(JSON.stringify(event))
  │
  ▼
Alice's and Bob's browsers
  │
  │  ws.onmessage = (e) => {
  │    const event = JSON.parse(e.data);   // type: 'IssueUpdated'
  │    store.dispatch(applyBoardUpdate(event));
  │  }
  │
  ▼
React board re-renders with updated issue title
```

The HTTP response to the developer's `PUT` has already been sent before the WebSocket broadcast completes — the two are independent and non-blocking.

---

### 14. Connection Lifecycle ASCII Diagram

```
CLIENT                          SERVER (WebSocketService)
  │                                       │
  │── GET /ws?projectId=X&userId=Y ──────>│  HTTP Upgrade handshake
  │<── 101 Switching Protocols ───────────│
  │                                       │  onConnection():
  │                                       │    ws.projectId = 'X'
  │                                       │    ws.userId = 'Y'
  │                                       │    rooms.get('X').add(ws)
  │                                       │    trackPresence(X, Y)
  │                                       │
  │  [optional: since query param]        │
  │<── buffered events replayed ──────────│  replayEvents()
  │                                       │
  │                 *** Normal Operation ***
  │                                       │
  │         [IssueUpdated fires]          │
  │<── {"type":"IssueUpdated",...} ───────│  broadcastToRoom()
  │                                       │  appendToReplayBuffer()
  │                                       │
  │         [CommentAdded fires]          │
  │<── {"type":"CommentAdded",...} ───────│  broadcastToRoom()
  │                                       │
  │                 *** Heartbeat (every 25s) ***
  │                                       │
  │<── PING frame ────────────────────────│  heartbeat() sends ping
  │── PONG frame ─────────────────────────>│  ws.isAlive = true
  │                                       │
  │                 *** Graceful Disconnect ***
  │                                       │
  │── CLOSE frame ─────────────────────────>│
  │                                       │  onDisconnect():
  │                                       │    rooms.get('X').delete(ws)
  │                                       │    untrackPresence(X, Y)
  │                                       │
  │                 *** Dead Connection (no pong) ***
  │                                       │
  │<── PING frame ────────────────────────│  heartbeat() — isAlive was false
  │   (no response)                       │  ws.terminate()
  │                                       │  onDisconnect() fires
```

---

### 15. What This Implementation Does NOT Handle

**Multi-pod event fan-out.** `broadcastToRoom` only iterates the in-memory `rooms` map on the current process. If two server pods are running and a domain event fires on Pod A, clients connected to Pod B will not receive it. Fixing this requires a Redis Pub/Sub adapter:

```typescript
// Pseudocode — Redis Pub/Sub extension to broadcastToRoom
import { createClient } from 'redis';

const publisher  = createClient();
const subscriber = createClient();

// At startup, each pod subscribes to the shared channel
await subscriber.subscribe('ws:broadcast', (message) => {
  const { projectId, event } = JSON.parse(message);
  this.broadcastLocalRoom(projectId, event); // only sends to THIS pod's sockets
});

// Replace broadcastToRoom with:
private async broadcastToRoom(projectId: string, event: AppDomainEvent): Promise<void> {
  await publisher.publish('ws:broadcast', JSON.stringify({ projectId, event }));
  // Redis delivers this to ALL pods, including this one
}
```

**Authentication at the WebSocket layer.** `userId` is read directly from the query string without verification. A real implementation would validate a JWT or session token before accepting the connection and registering the socket in a room.

**Per-user room filtering.** All clients in a project room receive all project events. A more granular design might restrict `CommentAdded` events only to clients involved in the issue, or filter based on user permissions.

**Backpressure.** If a client's TCP buffer is full (slow network, overwhelmed browser), `client.send()` will either queue internally or fail silently. The current implementation has no backpressure mechanism — it does not check `ws.bufferedAmount` before sending.

**Connection count limits per room.** Nothing prevents an unbounded number of clients from joining the same project room. Under very high load, a single `broadcastToRoom` call could iterate thousands of sockets synchronously on the event loop.

---

## Key Takeaways

- WebSockets start as HTTP requests and upgrade to a persistent bidirectional channel via the `101 Switching Protocols` response. The `ws` library handles the entire handshake; you interact only with the resulting socket object.
- The room pattern (`Map<projectId, Set<WebSocket>>`) is the foundational primitive for scoped fan-out. Connecting to the correct room is all a client needs to do — the server handles routing from domain events to rooms automatically.
- `WebSocketService` subscribes to the wildcard `'*'` on `DomainEventBus`, so every domain event published anywhere in the application (issue updates, sprint changes, comments) is automatically fanned out to the appropriate project room without any per-event wiring.
- The Redis replay buffer (ZSET scored by Unix timestamp) bridges the gap for reconnecting clients. Passing `?since=<lastEventMs>` on reconnect lets a client recover missed events without a full page reload or REST refetch.
- Redis presence tracking (HSET per user, EXPIRE as safety net) makes online/offline status queryable by any service in the system, not just the WebSocket layer.
- The heartbeat (ping every 25s, terminate if no pong) is essential for reclaiming OS file descriptors and room slots from connections that closed without a clean TCP FIN — for example, a laptop that lost Wi-Fi without sending a CLOSE frame.
- This implementation is single-pod only. Horizontal scaling requires replacing the in-memory `broadcastToRoom` with a Redis Pub/Sub fan-out pattern: each pod publishes to Redis, each pod's subscriber delivers to its own local sockets.
- Choosing `ws` over Socket.io is a deliberate trade-off: lower overhead and full control, at the cost of implementing reconnection, rooms, and event replay manually — all of which this codebase does.

---

## Further Reading

- **RFC 6455 — The WebSocket Protocol** (IETF, 2011): The original specification defining the handshake, framing, ping/pong, and close procedures. Available at https://datatracker.ietf.org/doc/html/rfc6455
- **"High Performance Browser Networking" by Ilya Grigorik** (O'Reilly, 2013, freely available online at https://hpbn.co): Chapter 17 covers WebSocket in depth including frame structure, performance characteristics, and a comparison with SSE and XHR polling. Chapter 16 covers SSE.
- **`ws` library documentation and source** (https://github.com/websockets/ws): The README covers the full API including `WebSocketServer`, ping/pong, backpressure, and external HTTP server integration — exactly the pattern used in this codebase.
- **"Designing Data-Intensive Applications" by Martin Kleppmann** (O'Reilly, 2017): Chapter 11 (Stream Processing) and the discussion of change data capture and event logs provide the theoretical underpinning for why domain events are the right mechanism to drive real-time clients.
- **Redis Pub/Sub documentation** (https://redis.io/docs/manual/pubsub/): Official reference for the `SUBSCRIBE`, `PUBLISH`, and `PSUBSCRIBE` commands. Pair with the `socket.io-redis` or `ioredis` examples to see how Pub/Sub enables multi-pod WebSocket fan-out.
