import {
  type DrizzleDb,
  getDb,
  getMainDbReadOnly,
} from "../persistence/db-connection.js";

/**
 * Main-DB resolution for the telemetry stores' unreported-event queries.
 *
 * The queries run in two processes with different postures: the daemon owns
 * the main DB's read-write connection, while the resource monitor process
 * observes the daemon's main DB through a dedicated read-only connection
 * (WAL permits cross-process readers; the daemon stays the sole writer, and
 * an accidental monitor-side write fails loudly). The monitor opts into the
 * read-only posture once at startup; everything else resolves to the normal
 * read-write connection.
 */

let readOnlyPosture = false;

/**
 * Switch this process's telemetry main-DB reads to the dedicated read-only
 * connection. Called once at resource monitor startup, before the first
 * flush; never unset — the posture is process-scoped by design.
 */
export function useReadOnlyMainDbForTelemetry(): void {
  readOnlyPosture = true;
}

/**
 * The main-DB connection for telemetry queries: `getDb()`'s read-write
 * connection in the daemon, the dedicated read-only connection in the
 * resource monitor. Throws when the read-only connection cannot be opened
 * (e.g. a fresh install where the daemon has not created the file yet) —
 * the reporter's flush treats that as non-fatal and retries next cycle.
 */
export function getTelemetryMainDb(): DrizzleDb {
  if (!readOnlyPosture) {
    return getDb();
  }
  const db = getMainDbReadOnly();
  if (!db) {
    throw new Error(
      "read-only main DB connection unavailable — retried next flush cycle",
    );
  }
  return db;
}
