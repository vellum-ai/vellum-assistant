import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `call_site` (nullable TEXT) to the `llm_request_logs` table.
 *
 * Records the logical call site that produced the row — `mainAgent`,
 * `compactionAgent`, etc. (string values from `LLMCallSite` in
 * `config/schemas/llm.ts`). Lets the LLM Context Inspector and other
 * observability tools filter "show me only compaction calls" without
 * having to infer from request payload shape.
 *
 * No backfill — historical rows stay NULL ("we don't know"). New rows
 * stamped at insertion time by callers of `recordRequestLog`.
 *
 * Idempotent — re-running is a no-op once the column exists. Modeled on
 * migration 252 (`llm-request-log-agent-loop-exit-reason`).
 *
 * When `llm_request_logs` is absent from `main` entirely, migration 297 has
 * relocated it to the logs database, whose schema already includes
 * `call_site` — so a re-run against a post-relocation database skips the
 * column add rather than ALTERing a missing table. (`PRAGMA table_info`
 * returns an empty list — not an error — for a missing table, so the empty
 * result must be treated as "table gone", never "column missing".)
 */
export function migrateLlmRequestLogCallSite(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(llm_request_logs)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (columns.length === 0) {
    return;
  }

  if (!columnNames.has("call_site")) {
    raw.exec(`ALTER TABLE llm_request_logs ADD COLUMN call_site TEXT`);
  }
}
