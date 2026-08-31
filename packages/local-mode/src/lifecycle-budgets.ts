/**
 * Timeouts shared between the CLI's lifecycle commands and the host wrappers
 * that spawn them.
 *
 * A host wrapper kills the CLI subprocess when its own timeout expires, so
 * every wrapper timeout must sit above the budget of the command it runs.
 * Otherwise a slow-but-succeeding command is killed partway and misreported as
 * a failure, and the SIGKILL ceiling it was waiting on is never reached.
 * Deriving the wrapper timeouts from the same constant keeps the two from
 * drifting apart.
 */

/**
 * SIGKILL ceiling for stopping the assistant daemon.
 *
 * Derived from the daemon's own budget rather than guessed. Its shutdown arms
 * a 30s force-exit timer; when that fires it hands the SQLite WAL fold to a
 * detached subprocess that outlives `process.exit` and then exits. So a daemon
 * whose event loop still runs is gone within 30s with its WAL folded, and a
 * daemon whose event loop is blocked never fires that timer at all, which no
 * amount of extra waiting changes. Waiting past the daemon's own ceiling plus
 * a margin therefore buys nothing and only delays the SIGKILL.
 *
 * A ceiling, not a delay. The CLI returns as soon as the process exits, so
 * this only applies to a daemon that is genuinely wedged.
 */
export const DAEMON_STOP_TIMEOUT_MS = 45_000;

/**
 * Headroom a host wrapper allows on top of {@link DAEMON_STOP_TIMEOUT_MS} for
 * the rest of a command: the gateway's drain window, the CES and Qdrant stops,
 * and any archiving or bring-up the command does around them.
 */
export const HOST_WRAPPER_HEADROOM_MS = 30_000;

/** Headroom for commands that also archive or provision after stopping. */
export const HOST_WRAPPER_LONG_HEADROOM_MS = 60_000;

/**
 * How long the CLI polls a freshly started daemon for readiness before giving
 * up on it.
 *
 * A command that starts a daemon spends this before it can even discover it
 * needs to stop one, so its wrapper budget has to cover the wait and the stop
 * that may follow it, not just the stop.
 */
export const DAEMON_READINESS_WINDOW_MS = 60_000;
