import type { DrizzleDb } from "../db-connection.js";

/**
 * Indexes `tool_invocations(created_at, id)` so the tool_execution telemetry
 * cursor can seek to the next unreported batch instead of scanning the table.
 *
 * `queryUnreportedToolExecutionEvents` filters and orders by `(created_at, id)`
 * every telemetry flush (~5 min); without this index each flush scans and
 * sorts the whole audit table, which grows unboundedly by default and carries
 * large `input`/`result` text blobs.
 *
 * Idempotent — `CREATE INDEX IF NOT EXISTS` is a no-op once the index exists.
 */
export function migrateToolInvocationsCreatedAtIdIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_created_at_id ON tool_invocations (created_at, id)`,
  );
}
