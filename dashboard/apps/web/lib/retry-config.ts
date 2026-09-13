/**
 * Streaming LLM responses use a different failure model than request/response:
 * retrying is only safe *before* the first byte arrives. These bounds apply to
 * the server-side stream path (app/api/chat).
 */
export const STREAM_CONFIG = {
  /** deadline for opening the upstream connection, per connect attempt */
  CONNECT_TIMEOUT_MS: 20_000,
  /** connect failures retried this many times (first-byte not yet seen) */
  MAX_CONNECT_RETRIES: 2,
  /** abort if no stream delta arrives within this window */
  IDLE_TIMEOUT_MS: 60_000,
  /** hard ceiling on a single generation, end to end */
  TOTAL_TIMEOUT_MS: 120_000,
} as const;
