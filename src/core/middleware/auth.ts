import { Middleware } from 'koa';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { UnauthorizedError } from '../errors/errors';
import { redis } from '../../config/redis';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';

export interface JwtPayload {
  sub: string;
  email: string;
  jti: string;
  iat: number;
  exp: number;
}

/** Validates Bearer JWT, checks revocation list, and attaches user to ctx.state */
export const authenticate: Middleware = async (ctx, next) => {
  const authHeader = ctx.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Bearer token');

  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const revoked = await redis.exists(CacheKeys.jwtRevoked(payload.jti));
  if (revoked) throw new UnauthorizedError('Token has been revoked');

  ctx.state.user = { id: payload.sub, email: payload.email };
  (ctx.state as any).jti = payload.jti;
  await next();
};
