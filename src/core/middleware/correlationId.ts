import { Middleware } from 'koa';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export const correlationStore = new AsyncLocalStorage<string>();

/** Injects X-Correlation-ID into ctx.state and response headers; creates one if absent */
export const correlationId: Middleware = async (ctx, next) => {
  const id = (ctx.headers['x-correlation-id'] as string) ?? randomUUID();
  ctx.state.correlationId = id;
  ctx.set('X-Correlation-ID', id);
  await correlationStore.run(id, next);
};
