import Koa from 'koa';
import Router from '@koa/router';
import cors from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import helmet from 'koa-helmet';
import { koaSwagger } from 'koa2-swagger-ui';
import swaggerJsdoc from 'swagger-jsdoc';

import { correlationId } from './core/middleware/correlationId';
import { errorHandler } from './core/middleware/errorHandler';
import { requestLogger } from './core/middleware/requestLogger';
import { metricsMiddleware } from './infrastructure/metrics/MetricsMiddleware';
import { rateLimiter } from './core/middleware/rateLimiter';
import { healthRouter } from './modules/health/routes/healthRoutes';
import { authRouter } from './modules/auth/routes/v1/authRoutes';
import { projectRouter } from './modules/projects/routes/v1/projectRoutes';
import { sprintRouter } from './modules/sprints/routes/v1/sprintRoutes';
import { activityRouter } from './modules/activity/routes/v1/activityRoutes';
import { issueRouter } from './modules/issues/routes/v1/issueRoutes';
import { commentRouter } from './modules/comments/routes/v1/commentRoutes';
import { searchRouter } from './modules/search/routes/v1/searchRoutes';

/** Factory function — creates and configures the Koa application instance */
export const createApp = (): Koa => {
  const app = new Koa();

  app.use(correlationId);
  app.use(errorHandler);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.use(rateLimiter);
  app.use(helmet());
  app.use(cors({ credentials: true }));
  app.use(bodyParser({ jsonLimit: '5mb' }));

  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: { title: 'Project Management Platform API', version: '1.0.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    apis: ['./src/modules/**/routes/**/*.ts'],
  });

  app.use(koaSwagger({ routePrefix: '/docs', swaggerOptions: { spec: swaggerSpec as Record<string, unknown> } }));

  const apiRouter = new Router({ prefix: '/api/v1' });
  apiRouter.use(authRouter.routes());
  apiRouter.use(authRouter.allowedMethods());
  apiRouter.use(projectRouter.routes());
  apiRouter.use(projectRouter.allowedMethods());
  apiRouter.use(issueRouter.routes());
  apiRouter.use(issueRouter.allowedMethods());
  apiRouter.use(sprintRouter.routes());
  apiRouter.use(sprintRouter.allowedMethods());
  apiRouter.use(activityRouter.routes());
  apiRouter.use(activityRouter.allowedMethods());
  apiRouter.use(commentRouter.routes());
  apiRouter.use(commentRouter.allowedMethods());
  apiRouter.use(searchRouter.routes());
  apiRouter.use(searchRouter.allowedMethods());

  app.use(apiRouter.routes());
  app.use(apiRouter.allowedMethods());
  app.use(healthRouter.routes());
  app.use(healthRouter.allowedMethods());

  return app;
};
