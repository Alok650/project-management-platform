/**
 * Integration test: Circuit breaker opens after threshold failures.
 *
 * Verifies the full state machine:
 *  CLOSED → (threshold failures) → OPEN → immediate rejection without calling fn
 *
 * Redis is mocked at the module level; no real Redis connection is needed.
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

const redisMock = {
  get:   jest.fn(),
  set:   jest.fn(),
  setex: jest.fn(),
  del:   jest.fn(),
};

jest.mock('../../src/config/redis', () => ({
  redis:    redisMock,
  redisSub: { ...redisMock },
}));

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    DB_POOL_MAX: 5,
    REDIS_URL: 'redis://localhost:6379',
  },
}));

jest.mock('../../src/config/database', () => ({
  AppDataSource: { transaction: jest.fn(), getRepository: jest.fn() },
}));

jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { CircuitBreaker } from '../../src/modules/notifications/CircuitBreaker';
import { CacheKeys } from '../../src/infrastructure/cache/CacheKeys';

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CircuitBreaker – state machine', () => {
  const CB_NAME      = 'test-cb';
  const THRESHOLD    = 3;
  const TIMEOUT_SECS = 30;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: circuit is CLOSED (no key in Redis)
    redisMock.get.mockResolvedValue(null);
    redisMock.setex.mockResolvedValue('OK');
    redisMock.del.mockResolvedValue(1);
  });

  describe('CLOSED state', () => {
    it('executes the function and returns its result when the circuit is closed', async () => {
      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
      const result = await cb.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('increments internal failure count on each failure', async () => {
      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);

      // First two failures — circuit stays closed (below threshold)
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

      expect(redisMock.setex).not.toHaveBeenCalled();
    });
  });

  describe('OPEN transition', () => {
    it('calls redis.setex with OPEN state after reaching the failure threshold', async () => {
      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);

      for (let i = 0; i < THRESHOLD; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error('downstream failure'))),
        ).rejects.toThrow('downstream failure');
      }

      expect(redisMock.setex).toHaveBeenCalledWith(
        CacheKeys.circuitBreaker(CB_NAME),
        TIMEOUT_SECS,
        'OPEN',
      );
    });

    it('calls redis.setex exactly once when threshold is hit on the final failure', async () => {
      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);

      for (let i = 0; i < THRESHOLD; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error('fail'))),
        ).rejects.toThrow();
      }

      // setex should only be called when the count reaches threshold (the 3rd call)
      expect(redisMock.setex).toHaveBeenCalledTimes(1);
    });
  });

  describe('OPEN state', () => {
    beforeEach(() => {
      // Simulate Redis already holding the OPEN state
      redisMock.get.mockResolvedValue('OPEN');
    });

    it('throws immediately without invoking the function when circuit is OPEN', async () => {
      const cb  = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
      const fn  = jest.fn(() => Promise.resolve('should not run'));

      await expect(cb.execute(fn)).rejects.toThrow(`Circuit breaker '${CB_NAME}' is OPEN`);
      expect(fn).not.toHaveBeenCalled();
    });

    it('does not call redis.setex when the circuit is already OPEN', async () => {
      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
      await expect(cb.execute(() => Promise.resolve())).rejects.toThrow();
      expect(redisMock.setex).not.toHaveBeenCalled();
    });
  });

  describe('HALF_OPEN state', () => {
    it('resets to CLOSED (calls redis.del) on a successful execution from HALF_OPEN', async () => {
      redisMock.get.mockResolvedValue('HALF_OPEN');

      const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
      await cb.execute(() => Promise.resolve('probe ok'));

      expect(redisMock.del).toHaveBeenCalledWith(CacheKeys.circuitBreaker(CB_NAME));
    });
  });
});
