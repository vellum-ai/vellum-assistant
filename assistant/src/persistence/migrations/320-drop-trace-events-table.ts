import type { DrizzleDb } from "../db-connection.js";

/**
 * Drops the `trace_events` table. Trace events were a diagnostic timeline
 * persisted to back the Logs panel, but that data duplicates the live events
 * SSE stream and the durable `tool_invocations` / `llm_request_logs` tables,
 * so the subsystem (emitter, route, and UI) has been removed. The table only
 * grew the main DB file with redundant rows.
 *
 * Idempotent: DROP TABLE IF EXISTS (its indexes are dropped with it).
 */
export function migrateDropTraceEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `DROP TABLE IF EXISTS trace_events`);
}
