import { IssuePriority } from './types/enums';

export const CORE_CONSTANTS = {
  DEFAULT_PAGE_LIMIT:       25,
  MAX_PAGE_LIMIT:           100,
  JWT_REVOKED_KEY_PREFIX:   'jwt:revoked:',
  RATE_LIMIT_WINDOW_MS:     60_000,
  RATE_LIMIT_GLOBAL_MAX:    1_000,
  CONCURRENCY_LIMIT:        5,
  DEFAULT_PRIORITY:         IssuePriority.MEDIUM,
  BOARD_CACHE_TTL_SECONDS:  30,
  PRESENCE_TTL_SECONDS:     300,
  EVENT_REPLAY_WINDOW_MS:   30_000,
} as const;
