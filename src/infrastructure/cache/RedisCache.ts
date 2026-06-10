import { redis } from '../../config/redis';

/** Generic Redis JSON cache with TTL support */
export class RedisCache {
  /**
   * Retrieve a cached value by key.
   * @returns Parsed value or null if missing/expired
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /**
   * Store a value as JSON with a TTL.
   * @param key - Cache key
   * @param value - Value to serialise
   * @param ttlSeconds - Expiry in seconds
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  }

  /** Delete a single cache key */
  async del(key: string): Promise<void> {
    await redis.del(key);
  }

  /**
   * Delete all keys matching a glob pattern using SCAN (non-blocking).
   * @param pattern - Redis glob pattern, e.g. 'board:proj_*'
   */
  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}

export const redisCache = new RedisCache();
