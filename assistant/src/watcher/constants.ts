/** Default poll interval for watchers (60 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Maximum backoff delay (1 hour). */
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Disable watcher after this many consecutive errors. */
export const MAX_CONSECUTIVE_ERRORS = 5;
