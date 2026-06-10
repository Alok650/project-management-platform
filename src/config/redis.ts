import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../infrastructure/logger/Logger';

const makeClient = (): Redis => {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('connect', () => logger.info('Redis connected'));
  return client;
};

/** Main Redis client for commands */
export const redis = makeClient();

/** Dedicated subscriber client — cannot run regular commands while subscribed */
export const redisSub = makeClient();
