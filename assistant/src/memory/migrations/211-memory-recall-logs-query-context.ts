import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_memory_recall_logs_query_context_v1";

/**
 * Add query_context column to memory_recall_logs to persist the query text
 * that drove semantic search, enabling the inspector to show what was searched.
 */
export function migrateMemoryRecallLogsQueryContext(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    if (!tableHasColumn(database, "memory_recall_logs", "query_context")) {
      const raw = getSqliteFrom(database);
      raw.exec(
        `ALTER TABLE memory_recall_logs ADD COLUMN query_context TEXT`,
      );
    }
  });
}
