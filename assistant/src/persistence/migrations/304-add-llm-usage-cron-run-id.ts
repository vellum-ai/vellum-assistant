import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "cron_run_id";
const COLUMN_DEFINITION = "cron_run_id TEXT";

/**
 * Add `cron_run_id` column to the `llm_usage_events` table.
 *
 * The column is a nullable, free-form identifier of the cron firing (run) that
 * incurred this LLM usage, enabling per-firing cost attribution for script-mode
 * schedules. It is intentionally NOT a foreign key to `cron_runs`: usage events
 * outlive run rows and must survive run pruning without cascade churn.
 *
 * No backfill is needed — all existing rows default to NULL (not attributable
 * to a cron firing), which is correct for any pre-migration usage.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot. The index uses `IF NOT EXISTS` for the same reason.
 */
export function migrateAddLlmUsageCronRunId(database: DrizzleDb): void {
  if (!tableHasColumn(database, "llm_usage_events", COLUMN_NAME)) {
    database.run(
      `ALTER TABLE llm_usage_events ADD COLUMN ${COLUMN_DEFINITION}`,
    );
  }
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_cron_run_id ON llm_usage_events(cron_run_id)`,
  );
}
