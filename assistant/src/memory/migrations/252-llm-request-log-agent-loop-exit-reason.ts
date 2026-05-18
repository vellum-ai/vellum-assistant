import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `agent_loop_exit_reason` (nullable TEXT) to the `llm_request_logs`
 * table.
 *
 * The agent loop sets this column on its final log row via
 * `setAgentLoopExitReasonOnLatestLog` once the `while (true)` body exits.
 * Intermediate rows keep NULL — downstream tooling (notably the LLM
 * Context Inspector) reads "row has non-null value" as "this is the final
 * call of a complete agent-loop run". Encoding the run-end via row state
 * keeps the schema additive: no new tables, no FK churn.
 *
 * Idempotent — re-running is a no-op once the column exists. Modeled on
 * migration 250 (`provider-connection-base-url-and-models`).
 */
export function migrateLlmRequestLogAgentLoopExitReason(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(llm_request_logs)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("agent_loop_exit_reason")) {
    raw.exec(
      `ALTER TABLE llm_request_logs ADD COLUMN agent_loop_exit_reason TEXT`,
    );
  }
}
