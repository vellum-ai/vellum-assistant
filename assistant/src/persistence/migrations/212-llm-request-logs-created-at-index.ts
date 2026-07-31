import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add an index on `llm_request_logs.created_at` so time-range deletes
 * (used by the log-pruning GC job) can scan efficiently without a full
 * table scan.
 */
export function migrateLlmRequestLogsCreatedAtIndex(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created_at ON llm_request_logs(created_at)`,
  );
}
