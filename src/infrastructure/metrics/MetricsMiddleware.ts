import { Context, Next } from 'koa';
import { metricsRegistry } from './MetricsRegistry';

/**
 * Koa middleware that records HTTP request duration and total count.
 * Attach before route handlers so it wraps the full request lifecycle.
 */
export const metricsMiddleware = async (ctx: Context, next: Next): Promise<void> => {
  const end = metricsRegistry.httpRequestDuration.startTimer();
  metricsRegistry.activeConnections.inc();

  try {
    await next();
  } finally {
    const labels = {
      method: ctx.method,
      route:  ctx.routerPath ?? ctx.path,
      status: String(ctx.status),
    };
    end(labels);
    metricsRegistry.httpRequestTotal.inc(labels);
    metricsRegistry.activeConnections.dec();
  }
};
