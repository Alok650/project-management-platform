import { Context } from 'koa';
import { AppDataSource } from '../../config/database';
import { redis } from '../../config/redis';
import { metricsRegistry } from '../../infrastructure/metrics/MetricsRegistry';

/** Liveness and readiness probe handlers for Kubernetes-style health checks */
export class HealthController {
  /** GET /api/health/live — always 200 if process is alive */
  static live(ctx: Context): void {
    ctx.body = { status: 'ok' };
  }

  /**
   * GET /api/health/ready — 200 only if DB and Redis are reachable.
   * Returns 503 with detail if any dependency is down.
   */
  static async ready(ctx: Context): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {};
    let healthy = true;

    try {
      await AppDataSource.query('SELECT 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'error';
      healthy = false;
    }

    try {
      await redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'error';
      healthy = false;
    }

    ctx.status = healthy ? 200 : 503;
    ctx.body   = { status: healthy ? 'ok' : 'degraded', checks };
  }

  /** GET /metrics — Prometheus text exposition format */
  static async metrics(ctx: Context): Promise<void> {
    ctx.set('Content-Type', metricsRegistry.registry.contentType);
    ctx.body = await metricsRegistry.registry.metrics();
  }
}
