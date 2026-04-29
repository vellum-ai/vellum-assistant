/** Default poll interval for watchers (60 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Disable watcher after this many consecutive errors. */
export const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * Hard timeout for a single watcher's event-processing background job.
 * Mirrors the order of magnitude used by sibling background producers
 * (filing: 15min, heartbeat: 30min) — chosen to keep a wedged tick from
 * blocking subsequent watchers indefinitely.
 */
export const WATCHER_JOB_TIMEOUT_MS = 15 * 60 * 1000;
