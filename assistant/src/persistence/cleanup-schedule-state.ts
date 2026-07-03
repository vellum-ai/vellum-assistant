/**
 * Shared state for the cleanup-scheduler throttle.
 *
 * `maybeEnqueueScheduledCleanupJobs` in jobs-worker.ts gates cleanup-job
 * enqueueing behind a 6-hour window (configurable via
 * memory.cleanup.enqueueIntervalMs). This module owns the "last enqueue"
 * timestamp so that code paths outside jobs-worker — notably
 * ConfigWatcher.refreshConfigFromSources — can reset the throttle without
 * pulling in jobs-worker's large transitive import graph.
 *
 * The ConfigWatcher uses resetCleanupScheduleThrottle() to ensure that
 * retention changes made via the UI (which flow through config.json →
 * invalidateConfigCache → refreshConfigFromSources) take effect on the
 * very next scheduler tick instead of waiting out the remaining window.
 */

let lastScheduledCleanupEnqueueMs = 0;

/** Read the timestamp of the most recent enqueue (0 if never/reset). */
export function getLastScheduledCleanupEnqueueMs(): number {
  return lastScheduledCleanupEnqueueMs;
}

/** Record that an enqueue just happened at `nowMs`. */
export function markScheduledCleanupEnqueued(nowMs: number): void {
  lastScheduledCleanupEnqueueMs = nowMs;
}

/**
 * Clear the throttle so the next `maybeEnqueueScheduledCleanupJobs` call
 * bypasses the `enqueueIntervalMs` window. Used by ConfigWatcher when
 * retention settings change, and by tests that need deterministic
 * scheduling.
 */
export function resetCleanupScheduleThrottle(): void {
  lastScheduledCleanupEnqueueMs = 0;
}
