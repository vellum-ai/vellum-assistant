import { getLogsSqlite } from "../db-connection.js";

/**
 * Adds `latency_breakdown` (nullable TEXT) to the `llm_request_logs` table in
 * the logs database (`assistant-logs.db`, where migration 297 relocated the
 * table).
 *
 * Stores the daemon-measured first-token latency waterfall as JSON
 * (`LatencyBreakdown` in `api/responses/llm-request-log-entry.ts`): queue →
 * memory/context retrieval → setup → request prep → time-to-first-token →
 * generation. Lets the LLM call inspector show where a turn's
 * time-to-first-token went. No backfill — historical rows stay NULL; new
 * main-agent rows are stamped at insertion time by `recordRequestLog`.
 *
 * Idempotent (`PRAGMA table_info` guard). Throws when the logs DB cannot be
 * opened so the runner records the step as failed and retries on a later boot,
 * rather than marking it applied without ever adding the column. Modeled on
 * migration 264 (`llm-request-log-call-site`), targeting the logs connection
 * like migration 297.
 */
export function migrateLlmRequestLogLatencyBreakdown(): void {
  const raw = getLogsSqlite();
  if (!raw) {
    throw new Error(
      "logs database unavailable — deferring llm_request_logs latency_breakdown column add",
    );
  }

  const columns = raw
    .query(`PRAGMA table_info(llm_request_logs)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("latency_breakdown")) {
    raw.exec(`ALTER TABLE llm_request_logs ADD COLUMN latency_breakdown TEXT`);
  }
}
