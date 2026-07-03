import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add an index on `trace_events.created_at` so the periodic prune job
 * can locate expired rows without a full table scan.
 */
export function migrateTraceEventsCreatedAtIndex(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_trace_events_created_at ON trace_events(created_at)`,
  );
}
