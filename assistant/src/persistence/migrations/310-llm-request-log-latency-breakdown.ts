import { getLogsSqlite } from "../db-connection.js";
import { ensureLlmRequestLogsSchema } from "./297-move-llm-request-logs-to-logs-db.js";

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
 * Self-healing: the schema ensure from migration 297 runs first, so a logs
 * database missing the table entirely (a vbundle import carries the main DB's
 * migration bookkeeping but not `assistant-logs.db`, so the relocation never
 * re-runs) gets the table and its indexes recreated instead of the column add
 * failing with `no such table`. `PRAGMA table_info` returns an empty list —
 * not an error — for a missing table, so without the ensure the column guard
 * would pass and the `ALTER TABLE` would throw on every boot.
 *
 * Idempotent (`IF NOT EXISTS` schema ensure + `PRAGMA table_info` column
 * guard). Throws when the logs DB cannot be opened so the runner records the
 * step as failed and retries on a later boot, rather than marking it applied
 * without ever adding the column. Modeled on migration 264
 * (`llm-request-log-call-site`), targeting the logs connection like
 * migration 297.
 */
export function migrateLlmRequestLogLatencyBreakdown(): void {
  const raw = getLogsSqlite();
  if (!raw) {
    throw new Error(
      "logs database unavailable — deferring llm_request_logs latency_breakdown column add",
    );
  }

  ensureLlmRequestLogsSchema(raw);

  const columns = raw
    .query(`PRAGMA table_info(llm_request_logs)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("latency_breakdown")) {
    raw.exec(`ALTER TABLE llm_request_logs ADD COLUMN latency_breakdown TEXT`);
  }
}
