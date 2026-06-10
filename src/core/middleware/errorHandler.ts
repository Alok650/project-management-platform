import { Middleware } from 'koa';
import { AppError } from '../errors/AppError';
import { logger } from '../../infrastructure/logger/Logger';

/** Global Koa error handler — maps AppError subclasses to typed JSON responses */
export const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof AppError) {
      ctx.status = err.statusCode;
      ctx.body = {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          correlationId: ctx.state.correlationId,
        },
      };
      if (err.statusCode >= 500) {
        logger.error({ err, correlationId: ctx.state.correlationId }, 'Unhandled app error');
      }
    } else {
      ctx.status = 500;
      ctx.body = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', correlationId: ctx.state.correlationId } };
      logger.error({ err, correlationId: ctx.state.correlationId }, 'Unhandled error');
    }
  }
};
