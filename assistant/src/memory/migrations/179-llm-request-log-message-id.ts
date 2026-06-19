import type { DrizzleDb } from "../db-connection.js";

/**
 * The `llm_request_logs.message_id` column and its index are part of the
 * table created in the attached `logs` database by migration 297
 * (move-llm-request-logs-to-logs-db). This step is intentionally a no-op and
 * is retained to preserve migration ordering.
 */
export function migrateLlmRequestLogMessageId(_database: DrizzleDb): void {}
