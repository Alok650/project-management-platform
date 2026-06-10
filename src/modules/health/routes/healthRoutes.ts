/**
 * @swagger
 * tags:
 *   - name: Health
 *     description: Kubernetes probes and Prometheus metrics
 *
 * /api/health/live:
 *   get:
 *     summary: Liveness probe — process is up
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is alive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *
 * /api/health/ready:
 *   get:
 *     summary: Readiness probe — DB and Redis connectivity verified
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is ready to serve traffic
 *       503:
 *         description: One or more dependencies are unavailable
 *
 * /metrics:
 *   get:
 *     summary: Prometheus metrics (text/plain exposition format)
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Prometheus scrape target — request latencies, error rates, WS connections
 */
import Router from '@koa/router';
import { HealthController } from '../HealthController';

export const healthRouter = new Router();

/** GET /api/health/live — Kubernetes liveness probe */
healthRouter.get('/api/health/live', HealthController.live);

/** GET /api/health/ready — Kubernetes readiness probe, checks DB and Redis */
healthRouter.get('/api/health/ready', HealthController.ready);

/** GET /metrics — Prometheus text exposition metrics endpoint */
healthRouter.get('/metrics', HealthController.metrics);
