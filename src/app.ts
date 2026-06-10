import Koa from 'koa';
import Router from '@koa/router';
import cors from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import helmet from 'koa-helmet';
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
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Allow cdnjs for swagger-ui scripts (koa2-swagger-ui loads from CDN)
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      },
    },
  }));
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
    // Resolve route files relative to this module so the glob works both in
    // dev (.ts under src/) and in the compiled production image (.js under dist/).
    apis: [`${__dirname}/modules/**/routes/**/*.${__filename.endsWith('.ts') ? 'ts' : 'js'}`],
  });

  // Serve OpenAPI spec and Swagger UI — using direct handlers rather than
  // koa2-swagger-ui whose Handlebars template generates broken JS for swagger-ui v5
  // (elision in plugins array, wrong .default preset access).
  const SWAGGER_VERSION = '5.18.2';
  const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Project Management Platform API</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui.css">
  <style>body { margin: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui-bundle.js"></script>
<script>
window.onload = () => {
  SwaggerUIBundle({
    url: '/spec.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'BaseLayout',
  });
};
</script>
</body>
</html>`;

  app.use(async (ctx, next) => {
    if (ctx.path === '/spec.json') {
      ctx.body = swaggerSpec;
      return;
    }
    if (ctx.path === '/') {
      ctx.type = 'text/html';
      ctx.body = swaggerHtml;
      return;
    }
    await next();
  });

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
