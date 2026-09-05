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
