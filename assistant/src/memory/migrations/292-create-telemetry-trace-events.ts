import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the telemetry_trace_events table — one row per agent turn buffering
 * the full per-turn execution trace (prompts, completions, tool calls/results,
 * token usage) for the product-improvement telemetry pipeline (see
 * telemetry-trace-events-store.ts for the data contract). Distinct from the
 * `trace_events` conversation activity log read by the UI. The index backs the
 * telemetry reporter's compound `(created_at, id)` watermark cursor.
 */
export function createTelemetryTraceEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS telemetry_trace_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      request_id TEXT,
      turn_index INTEGER,
      trace TEXT NOT NULL
    )
  `);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_trace_events_created_at_id ON telemetry_trace_events (created_at, id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_trace_events_conversation_id ON telemetry_trace_events (conversation_id)`,
  );
}
