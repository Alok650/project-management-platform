import { redis } from '../../config/redis';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { logger } from '../../infrastructure/logger/Logger';
import { NOTIFICATION_CONSTANTS } from './constants';

type CbState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Redis-backed circuit breaker implementation.
 * State machine: CLOSED → OPEN (on threshold failures) → HALF_OPEN (after timeout) → CLOSED (on success)
 * State is persisted in Redis so it survives process restarts.
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly threshold: number;
  private readonly timeout: number;
  private failureCount = 0;

  constructor(
    name: string,
    threshold: number = NOTIFICATION_CONSTANTS.CIRCUIT_BREAKER_THRESHOLD,
    timeoutSeconds: number = NOTIFICATION_CONSTANTS.CIRCUIT_BREAKER_TIMEOUT_SECONDS,
  ) {
    this.name      = name;
    this.threshold = threshold;
    this.timeout   = timeoutSeconds;
  }

  /** Read current circuit state from Redis */
  async getState(): Promise<CbState> {
    const raw = await redis.get(CacheKeys.circuitBreaker(this.name));
    return (raw as CbState | null) ?? 'CLOSED';
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws immediately if OPEN; resets on success from HALF_OPEN.
   *
   * @param fn - Async function to execute
   * @throws Error if circuit is OPEN or if fn throws and threshold is reached
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.getState();
    if (state === 'OPEN') throw new Error(`Circuit breaker '${this.name}' is OPEN`);

    try {
      const result = await fn();
      if (state === 'HALF_OPEN') {
        await redis.del(CacheKeys.circuitBreaker(this.name));
        this.failureCount = 0;
        logger.info({ circuitBreaker: this.name }, 'Circuit breaker CLOSED');
      }
      return result;
    } catch (err) {
      this.failureCount++;
      if (this.failureCount >= this.threshold) {
        await redis.setex(CacheKeys.circuitBreaker(this.name), this.timeout, 'OPEN');
        logger.warn({ circuitBreaker: this.name, threshold: this.threshold }, 'Circuit breaker OPEN');
      }
      throw err;
    }
  }
}
