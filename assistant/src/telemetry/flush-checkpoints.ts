import { eq } from "drizzle-orm";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { flushCheckpoints } from "../persistence/schema/index.js";

/**
 * Telemetry flush state — the per-event-type watermark cursors the usage
 * telemetry reporter advances after each successful upload. Backed by the
 * `flush_checkpoints` table on the dedicated telemetry database
 * (`assistant-telemetry.db`); the main DB's `memory_checkpoints` ledger is
 * reserved for DB-migration checkpoints.
 *
 * Reads and writes throw when the table is missing (migrations not yet run)
 * and are no-op/null when the telemetry DB cannot be opened at all. Callers
 * that must not mistake an unreadable store for "no watermark" (which would
 * re-ship history from cursor 0) should gate on
 * {@link isFlushCheckpointStoreAvailable} first.
 */

/** True when the telemetry DB connection is open. */
export function isFlushCheckpointStoreAvailable(): boolean {
  return getTelemetryDb() != null;
}

export function getFlushCheckpoint(key: string): string | null {
  const db = getTelemetryDb();
  if (!db) {
    return null;
  }
  const row = db
    .select({ value: flushCheckpoints.value })
    .from(flushCheckpoints)
    .where(eq(flushCheckpoints.key, key))
    .get();
  return row?.value ?? null;
}

export function setFlushCheckpoint(key: string, value: string): void {
  const db = getTelemetryDb();
  if (!db) {
    return;
  }
  const now = Date.now();
  db.insert(flushCheckpoints)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: flushCheckpoints.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Watermark storage seam for the usage telemetry reporter. The reporter
 * takes this as a constructor dependency (defaulting to
 * {@link telemetryDbFlushCheckpointStore}) so tests can substitute an
 * in-memory fake without process-global module mocking.
 */
export interface FlushCheckpointStore {
  isAvailable(): boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** The production store, backed by the telemetry DB's `flush_checkpoints`. */
export const telemetryDbFlushCheckpointStore: FlushCheckpointStore = {
  isAvailable: isFlushCheckpointStoreAvailable,
  get: getFlushCheckpoint,
  set: setFlushCheckpoint,
};
