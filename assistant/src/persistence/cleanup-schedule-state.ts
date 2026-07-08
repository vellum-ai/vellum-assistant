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
 * this module owns the in-memory per-job "last enqueue" timestamps so that code
 * paths outside jobs-worker — notably ConfigWatcher.refreshConfigFromSources —
 * can reset the throttle without pulling in jobs-worker's large transitive
 * import graph.
 *
 * These timestamps are the hot-path source of truth but are not themselves
 * durable: jobs-worker persists each enqueue to a checkpoint and seeds this map
 * from those checkpoints at startup, so an unchanged job's cadence survives a
 * restart instead of re-firing on every boot.
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
 * Clear every job's in-memory throttle so the next
 * `maybeEnqueueScheduledCleanupJobs` call re-enqueues immediately regardless of
 * each job's retention window. Used by ConfigWatcher when retention settings
 * change, and by tests that need deterministic scheduling.
 *
 * This clears only the in-memory timestamps; the persisted checkpoints are
 * rewritten by the next enqueue, so they self-heal on the following tick.
 */
export function resetCleanupScheduleThrottle(): void {
  lastScheduledCleanupEnqueueMs.conversations = 0;
  lastScheduledCleanupEnqueueMs.llm_request_logs = 0;
  lastScheduledCleanupEnqueueMs.tool_invocations = 0;
}
