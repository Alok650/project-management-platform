/** WebSocket service tuning constants */
export const WS_CONSTANTS = {
  PRESENCE_TTL_SECONDS:    300,
  REPLAY_WINDOW_SECONDS:   30,
  REPLAY_BUFFER_MAX_ITEMS: 100,
  PING_INTERVAL_MS:        25_000,
  HEARTBEAT_TIMEOUT_MS:    35_000,
} as const;
