/** TTL constants (seconds) for all Redis cache layers */
export const CACHE_TTL = {
  MEMBERSHIP_SECONDS:   300,   // 5 min — RBAC role lookup per user+project
  BOARD_SECONDS:        300,   // 5 min — full board view JSON (targeted invalidation on writes)
  ISSUE_ENTITY_SECONDS:  60,   // 60 s  — individual issue entity (short TTL; writes always DEL)
  SPRINT_LIST_SECONDS:  300,   // 5 min — project's sprint list
  PROJECT_LIST_SECONDS: 120,   // 2 min — user's visible project list
  INDEX_SECONDS:        600,   // 10 min — sprint/status sorted-set indexes
} as const;
