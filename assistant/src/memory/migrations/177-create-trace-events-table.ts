import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_create_trace_events_table_v1";

/**
 * Create the trace_events table for persisting trace/activity events
 * so the Logs panel has data across sessions.
 */
export function migrateCreateTraceEventsTable(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS trace_events (
        event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        request_id TEXT,
        timestamp_ms INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT,
        summary TEXT NOT NULL,
        attributes_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_trace_events_conversation_id
      ON trace_events (conversation_id)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_trace_events_conversation_timestamp
      ON trace_events (conversation_id, timestamp_ms)
    `);
  });
}
