/** Constants for the issues module */
export const ISSUE_CONSTANTS = {
  MAX_TITLE_LENGTH:         500,
  MAX_DESCRIPTION_LENGTH:   50_000,
  MAX_LABELS_PER_ISSUE:     20,
  MAX_STORY_POINTS:         100,
  BOARD_CACHE_TTL_SECONDS:  300,  // 5 min — safe to extend because writes always invalidate via pattern
} as const;
