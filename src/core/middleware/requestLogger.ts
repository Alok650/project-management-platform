import { Middleware } from 'koa';
import { logger } from '../../infrastructure/logger/Logger';

/** Logs method, path, status, and duration for every request */
export const requestLogger: Middleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  logger.info({
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    durationMs: Date.now() - start,
    correlationId: ctx.state.correlationId,
  }, 'request');
};
