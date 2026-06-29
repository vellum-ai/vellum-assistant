import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add query_context column to memory_recall_logs to persist the query text
 * that drove semantic search, enabling the inspector to show what was searched.
 */
export function migrateMemoryRecallLogsQueryContext(database: DrizzleDb): void {
  if (!tableHasColumn(database, "memory_recall_logs", "query_context")) {
    const raw = getSqliteFrom(database);
    raw.exec(`ALTER TABLE memory_recall_logs ADD COLUMN query_context TEXT`);
  }
}
