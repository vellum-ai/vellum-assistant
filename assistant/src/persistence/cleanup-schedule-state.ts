/**
 * Per-job throttle state for the cleanup scheduler.
 *
 * Each scheduled cleanup job is enqueued on a cadence equal to its own
 * retention window: a job that keeps data for N is re-enqueued at most once
 * per N. So conversation pruning, LLM-request-log pruning, and audit-log
 * (`tool_invocations`) pruning each run on their own independent schedule
 * derived from `conversationRetentionDays`, `llmRequestLogRetentionMs`, and
 * `auditLog.retentionDays` respectively.
 *
 * `maybeEnqueueScheduledCleanupJobs` in jobs-worker.ts owns that decision;
 * this module owns the per-job "last enqueue" timestamps so that code paths
 * outside jobs-worker — notably ConfigWatcher.refreshConfigFromSources — can
 * reset the throttle without pulling in jobs-worker's large transitive import
 * graph.
 *
 * The ConfigWatcher uses resetCleanupScheduleThrottle() to ensure that
 * retention changes made via the UI (which flow through config.json →
 * invalidateConfigCache → refreshConfigFromSources) take effect on the very
 * next scheduler tick instead of waiting out the remaining window.
 */

export type CleanupJobKind =
  | "conversations"
  | "llm_request_logs"
  | "tool_invocations";

const lastScheduledCleanupEnqueueMs: Record<CleanupJobKind, number> = {
  conversations: 0,
  llm_request_logs: 0,
  tool_invocations: 0,
};

/**
 * Read the timestamp of the most recent enqueue for `kind` (0 if never/reset).
 */
export function getLastScheduledCleanupEnqueueMs(kind: CleanupJobKind): number {
  return lastScheduledCleanupEnqueueMs[kind];
}

/** Record that an enqueue for `kind` just happened at `nowMs`. */
export function markScheduledCleanupEnqueued(
  kind: CleanupJobKind,
  nowMs: number,
): void {
  lastScheduledCleanupEnqueueMs[kind] = nowMs;
}

/**
 * Clear every job's throttle so the next `maybeEnqueueScheduledCleanupJobs`
 * call re-enqueues immediately regardless of each job's retention window. Used
 * by ConfigWatcher when retention settings change, and by tests that need
 * deterministic scheduling.
 */
export function resetCleanupScheduleThrottle(): void {
  lastScheduledCleanupEnqueueMs.conversations = 0;
  lastScheduledCleanupEnqueueMs.llm_request_logs = 0;
  lastScheduledCleanupEnqueueMs.tool_invocations = 0;
}
