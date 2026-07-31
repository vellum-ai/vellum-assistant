/**
 * Shared `'error'`-event handler for `fs.watch()` FSWatchers.
 *
 * An `FSWatcher` is an EventEmitter. When the underlying inotify/FSEvents
 * backend fails *after* the watch was established — e.g. ENOSPC when the
 * kernel's `fs.inotify.max_user_watches` limit is exhausted while walking a
 * recursive watch into a large subtree (a plugin's `node_modules`), or ENXIO
 * when a Unix socket file appears in a watched directory — the failure is
 * delivered asynchronously as an `'error'` event rather than a synchronous
 * throw from `watch()`. An emitter with no `'error'` listener rethrows, which
 * surfaces as an `uncaughtException` and takes the whole daemon down (→
 * CrashLoopBackOff).
 *
 * Attaching this handler degrades the failure to "this watcher stops
 * delivering events", in line with the daemon startup philosophy: a subsystem
 * failure must never crash the process.
 */

import type { FSWatcher } from "node:fs";

import type { Logger } from "pino";

/**
 * Attach a resilient `'error'` listener so async FSWatcher failures are logged
 * instead of crashing the process. Pass the owning module's logger and the
 * watched directory for diagnostic context.
 */
export function attachFsWatcherErrorHandler(
  watcher: FSWatcher,
  log: Logger,
  dir: string,
): void {
  watcher.on("error", (err) => {
    log.warn({ err, dir }, "FSWatcher error (non-fatal, continuing)");
  });
}
