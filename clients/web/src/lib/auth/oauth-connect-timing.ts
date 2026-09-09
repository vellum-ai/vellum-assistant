/**
 * Timing policy for the managed OAuth connect flow.
 *
 * Separated so tests can shrink the waits without holding a suite open for
 * real seconds, and so the two numbers that shape how long a user looks at a
 * spinner sit together rather than buried in the hook.
 */

/** Backstop poll while an authorization is open. */
export const CONNECTION_POLL_INTERVAL_MS = 3000;

/**
 * How long that poll runs. An attempt the user walked away from would
 * otherwise poll for the life of the tab. A refetch on window focus stays
 * armed past this, which is the signal that actually matters.
 */
export const CONNECTION_POLL_WINDOW_MS = 5 * 60_000;

/**
 * How long to keep looking for the granted account after the provider's
 * callback reported success. The row usually lands within a poll or two, but
 * the connections list does not model every provider the platform can
 * authorize, and a flow that succeeded must not wait on a row that is never
 * coming.
 */
export const CONNECTION_CONFIRM_WINDOW_MS = 15_000;
