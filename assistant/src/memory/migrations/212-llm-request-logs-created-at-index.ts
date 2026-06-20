import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_llm_request_logs_created_at_index_v1";

/**
 * Add an index on `llm_request_logs.created_at` so time-range deletes
 * (used by the log-pruning GC job) can scan efficiently without a full
 * table scan.
 */
export function migrateLlmRequestLogsCreatedAtIndex(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created_at ON llm_request_logs(created_at)`,
    );
  });
}
