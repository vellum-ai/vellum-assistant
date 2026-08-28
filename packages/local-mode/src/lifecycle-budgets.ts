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
 * The daemon's graceful shutdown fires plugin shutdown hooks, commits the
 * workspace, flushes telemetry, SIGTERMs the worker processes it owns
 * (schedule, route host, resource monitor, memory jobs), and folds the SQLite
 * WAL back into the database. Those steps run near the end of the sequence, so
 * a short grace period kills the daemon before it reaches them: the workers
 * reparent to init and keep running on that runtime version, and an
 * interrupted checkpoint costs a multi-minute WAL recovery on the next start.
 *
 * A ceiling, not a delay. The CLI returns as soon as the process exits, so
 * this only applies to a daemon that is genuinely wedged.
 */
export const DAEMON_STOP_TIMEOUT_MS = 120_000;

/**
 * Headroom a host wrapper allows on top of {@link DAEMON_STOP_TIMEOUT_MS} for
 * the rest of a command: the gateway's drain window, the CES and Qdrant stops,
 * and any archiving or bring-up the command does around them.
 */
export const HOST_WRAPPER_HEADROOM_MS = 30_000;

/** Headroom for commands that also archive or provision after stopping. */
export const HOST_WRAPPER_LONG_HEADROOM_MS = 60_000;
