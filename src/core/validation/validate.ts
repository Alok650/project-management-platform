import { Middleware, Context } from 'koa';
import Joi from 'joi';
import { ValidationError } from '../errors/errors';

type Target = 'body' | 'query' | 'params';

/**
 * Koa middleware factory that validates request data against a Joi schema.
 * @param schema - Joi schema to validate against
 * @param target - Which part of the request to validate (default: 'body')
 */
export const validate = (schema: Joi.ObjectSchema, target: Target = 'body'): Middleware =>
  async (ctx: Context, next) => {
    const source = target === 'body' ? ctx.request.body : target === 'query' ? ctx.query : ctx.params;
    const { error, value } = schema.validate(source, { abortEarly: false, stripUnknown: true });
    if (error) {
      const fields = Object.fromEntries(
        error.details.map((d) => [d.path.join('.'), d.message]),
      );
      throw new ValidationError('Validation failed', fields);
    }
    if (target === 'body') (ctx.request as any).body = value;
    else if (target === 'query') ctx.query = value;
    await next();
  };
