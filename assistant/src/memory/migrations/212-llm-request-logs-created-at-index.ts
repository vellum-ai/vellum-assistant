import type { DrizzleDb } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_llm_request_logs_created_at_index_v1";

/**
 * The `idx_llm_request_logs_created_at` index (used by the log-pruning GC job
 * for efficient time-range deletes) is created on the table in the attached
 * `logs` database by migration 297 (move-llm-request-logs-to-logs-db).
 *
 * The body is intentionally a no-op, but the crash-recovery wrapper is kept so
 * the registered checkpoint (`CHECKPOINT_KEY`) is still recorded — preserving
 * the migration registry and ordering.
 */
export function migrateLlmRequestLogsCreatedAtIndex(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {});
}
