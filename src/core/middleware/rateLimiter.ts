import { Context, Next } from 'koa';
import { redis } from '../../config/redis';
import { logger } from '../../infrastructure/logger/Logger';

const RATE_LIMIT_CONSTANTS = {
  WINDOW_SECONDS: 60,
  MAX_REQUESTS:   100,
} as const;

/**
 * Redis sliding-window rate limiter using a Sorted Set per client IP.
 * Each request is recorded as a member with score = current timestamp (ms).
 * Old members outside the window are pruned on every request.
 * Returns 429 when the request count in the window exceeds MAX_REQUESTS.
 */
export const rateLimiter = async (ctx: Context, next: Next): Promise<void> => {
  const ip  = ctx.ip || 'unknown';
  const key = `rate_limit:${ip}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_CONSTANTS.WINDOW_SECONDS * 1000;

  // Remove entries older than the window
  await redis.zremrangebyscore(key, '-inf', windowStart);

  // Count requests in the current window
  const count = await redis.zcard(key);

  if (count >= RATE_LIMIT_CONSTANTS.MAX_REQUESTS) {
    logger.warn({ ip, count }, 'Rate limit exceeded');
    ctx.status = 429;
    ctx.body   = { error: 'Too many requests. Please try again later.' };
    ctx.set('Retry-After', String(RATE_LIMIT_CONSTANTS.WINDOW_SECONDS));
    return;
  }

  // Record this request
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, RATE_LIMIT_CONSTANTS.WINDOW_SECONDS);

  ctx.set('X-RateLimit-Limit',     String(RATE_LIMIT_CONSTANTS.MAX_REQUESTS));
  ctx.set('X-RateLimit-Remaining', String(RATE_LIMIT_CONSTANTS.MAX_REQUESTS - count - 1));

  await next();
};
