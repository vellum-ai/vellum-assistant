/**
 * Timings for the contact forms the guardian fills in their app, shared by the
 * CLI that waits and the daemon route that holds the form open.
 *
 * One budget split across a socket and a timer, so the numbers live together
 * and the caller's wait is derived from the deadlines rather than written down
 * beside them. The invariant: the caller outlasts the form. A caller that
 * gives up first reports a failure while the write it was waiting on goes on
 * to commit.
 *
 * Under `util/` because the CLI hoists it: constants and one pure function,
 * with no daemon runtime graph behind it (`cli/no-daemon-internals`).
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
 * A claim means somebody answered, so the open-for-answers deadline stops
 * governing and this one takes over. It covers the gateway's whole write
 * rather than one call of it: its IPC calls bound at 30s each and a delete
 * makes three in sequence (mirror probe, mirror delete, then the resolve
 * back).
 */
export const CONTACT_FORM_SETTLE_MS = 180_000;

/** Slack on top of the deadlines, so the socket is never the first to give up. */
const CONTACT_FORM_TRANSPORT_BUFFER_MS = 10_000;

/**
 * How long a caller waits on a form that stays open for `timeoutMs`.
 *
 * Covers the answer window plus the settle window, since an answer landing at
 * the deadline starts the settle window from there. A caller that gives up
 * first reports a failure while the write proceeds, which for a delete means a
 * contact removed against a command that reported nothing happened.
 */
export function contactFormCallBudgetMs(timeoutMs: number): number {
  return timeoutMs + CONTACT_FORM_SETTLE_MS + CONTACT_FORM_TRANSPORT_BUFFER_MS;
}
