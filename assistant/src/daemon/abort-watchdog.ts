/**
 * Grace period after an abort signal fires for a turn to settle before the
 * abort watchdog force-unwinds the agent loop. Shared source of truth: the
 * voice session bridge sizes its processing-lock wait to cover this budget,
 * so the two must not drift.
 */
export const ABORT_WATCHDOG_MS = 5_000;

/**
 * How long a caller that just aborted a turn waits for that turn to release
 * the processing lock before treating it as wedged.
 *
 * The watchdog force-unwinds the agent loop at {@link ABORT_WATCHDOG_MS}; the
 * turn's own `finally` (turn-boundary commit, teardown, the release itself)
 * runs after that, so the wait has to cover both. The margin is what the
 * teardown gets. A clean abort settles in a few milliseconds, so the budget
 * only bounds the pathological case.
 */
export const ABORT_RELEASE_WAIT_MS = ABORT_WATCHDOG_MS + 2_000;

/**
 * Fallback for `workspaceGit.turnCommitMaxWaitMs`, matching the schema default.
 * Read by every caller that has to size a wait around the turn-boundary commit
 * and cannot assume the config carries the field.
 */
export const DEFAULT_TURN_COMMIT_MAX_WAIT_MS = 4_000;

/**
 * Slack on top of the commit budget, covering the rest of a turn's
 * post-release finalization (the reaction-record drain, the barrier close).
 */
export const TURN_FINALIZATION_MARGIN_MS = 1_000;

/**
 * How long to wait for a finished turn's turn-boundary commit to complete.
 *
 * The commit runs after the turn frees the conversation and attributes the
 * working tree to the turn that just ended, so anything that starts a turn on
 * the release alone has to cover this window or its first file writes land in
 * the previous turn's commit.
 */
export function resolveTurnCommitWaitMs(turnCommitMaxWaitMs?: number): number {
  return (
    (turnCommitMaxWaitMs ?? DEFAULT_TURN_COMMIT_MAX_WAIT_MS) +
    TURN_FINALIZATION_MARGIN_MS
  );
}
