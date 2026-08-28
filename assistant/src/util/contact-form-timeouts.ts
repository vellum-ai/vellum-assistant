/**
 * Timings for the contact forms the guardian fills in their app, shared by the
 * CLI that waits and the daemon route that holds the form open.
 *
 * They are one budget split across a socket and a timer, and the two halves
 * drifted apart once before: the daemon grew a settle window for a claimed
 * form while the caller kept giving up ten seconds after the form's own
 * deadline, so a write could commit after the command reported a timeout.
 * Keeping the numbers here, with the caller's budget derived rather than
 * written down twice, is what stops that recurring.
 *
 * Under `util/` because the CLI hoists it: it is constants and one pure
 * function, with no daemon runtime graph behind it (`cli/no-daemon-internals`).
 */

/** Default time a form stays open for an answer (5 min). */
export const CONTACT_FORM_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Ceiling on a caller-supplied wait (1 hour), so a bad value cannot park a
 * pending form indefinitely.
 */
export const CONTACT_FORM_MAX_TIMEOUT_MS = 3_600_000;

/**
 * How long a claimed form is held while its write settles (3 min).
 *
 * Claiming means somebody answered, so the open-for-answers deadline stops
 * applying. The budget has to clear the gateway's whole write, not one call of
 * it: its IPC calls bound at 30s each and a delete makes three in sequence
 * (mirror probe, mirror delete, then the resolve back).
 */
export const CONTACT_FORM_SETTLE_MS = 180_000;

/** Slack on top of the deadlines, so the socket is never the first to give up. */
const CONTACT_FORM_TRANSPORT_BUFFER_MS = 10_000;

/**
 * How long a caller waits on a form that stays open for `timeoutMs`.
 *
 * Covers the answer window plus the settle window a claim swaps in, because
 * an answer landing at the deadline starts the settle window from there. The
 * caller giving up first would report a failure while the write went on to
 * commit, which for a delete means a contact removed after the command said
 * nothing happened.
 */
export function contactFormCallBudgetMs(timeoutMs: number): number {
  return timeoutMs + CONTACT_FORM_SETTLE_MS + CONTACT_FORM_TRANSPORT_BUFFER_MS;
}
