import 'reflect-metadata';
import { createServer } from 'http';
import { createApp } from './app';
import { AppDataSource } from './config/database';
import { redis } from './config/redis';
import { logger } from './infrastructure/logger/Logger';
import { env } from './config/env';
import { ActivityService } from './modules/activity/ActivityService';
import { ActivityRepository } from './modules/activity/ActivityRepository';
import { WebSocketService } from './modules/websocket/WebSocketService';

/** Maximum milliseconds to wait for in-flight HTTP requests to drain on shutdown */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
/** Polling interval while waiting for in-flight requests to reach zero */
const SHUTDOWN_POLL_INTERVAL_MS = 100;

const bootstrap = async (): Promise<void> => {
  await AppDataSource.initialize();
  logger.info('Database connected');

  // Instantiate ActivityService so domain event subscriptions are registered at startup
  new ActivityService(new ActivityRepository());

  await redis.connect();

  const app = createApp();
  const httpServer = createServer(app.callback());

  // Wire up WebSocket real-time service
  const wsService = new WebSocketService(httpServer);

  // Track in-flight HTTP requests for graceful drain
  let inFlight = 0;
  httpServer.on('request', (_req, res) => {
    inFlight++;
    res.on('finish', () => { inFlight--; });
  });

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server started');
  });

  /**
   * Graceful shutdown sequence:
   * 1. Stop accepting new connections
   * 2. Drain in-flight HTTP requests (max SHUTDOWN_DRAIN_TIMEOUT_MS)
   * 3. Close WebSocket server
   * 4. Destroy TypeORM data source
   * 5. Quit Redis client
   * 6. Exit process
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new connections
    httpServer.close();

    // Wait for in-flight requests to drain (max SHUTDOWN_DRAIN_TIMEOUT_MS)
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHUTDOWN_POLL_INTERVAL_MS));
    }
    if (inFlight > 0) {
      logger.warn({ inFlight }, 'Shutdown timeout — forcing close with in-flight requests');
    }

    await wsService.close();
    await AppDataSource.destroy();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
};

bootstrap().catch((err) => {
  logger.error({ err }, 'Bootstrap failed');
  process.exit(1);
});
