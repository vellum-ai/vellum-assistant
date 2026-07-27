/**
 * Process-role signal: whether this OS process is the main assistant daemon or
 * something else (a sidecar worker — the resource monitor, memory jobs worker,
 * schedule worker, route host — the CLI, a test, …).
 *
 * The daemon owns the singletons real clients connect to — the event hub and
 * its SSE fan-out chief among them. Any other process runs its own disjoint
 * copies, so anything it publishes locally reaches no client; such code routes
 * to the live daemon over IPC when {@link isMainDaemonProcess} is false.
 *
 * Only the daemon knows it is the daemon: its entrypoint calls
 * {@link markCurrentProcessAsMainDaemon} once at startup. Every other process
 * (which never runs that entrypoint) is a non-daemon by default — no per-worker
 * bookkeeping to keep in sync.
 */

let mainDaemon = false;

/**
 * Mark the current process as the main assistant daemon. Called once, early in
 * the daemon entrypoint (`runDaemon`), before anything can publish an event.
 */
export function markCurrentProcessAsMainDaemon(): void {
  mainDaemon = true;
}

/**
 * Whether this is the main assistant daemon process. False everywhere the
 * daemon entrypoint did not run — sidecar workers, the route host, the CLI.
 */
export function isMainDaemonProcess(): boolean {
  return mainDaemon;
}
