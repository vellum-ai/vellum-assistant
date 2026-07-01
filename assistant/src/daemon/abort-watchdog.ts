/**
 * Grace period after an abort signal fires for a turn to settle before the
 * abort watchdog force-unwinds the agent loop. Shared source of truth: the
 * voice session bridge sizes its processing-lock wait to cover this budget,
 * so the two must not drift. See JARVIS-1232.
 */
export const ABORT_WATCHDOG_MS = 5_000;
