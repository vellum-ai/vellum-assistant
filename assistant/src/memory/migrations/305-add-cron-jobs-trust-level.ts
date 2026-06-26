import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "trust_level";
const COLUMN_DEFINITION = "trust_level TEXT";

/**
 * Add `trust_level` column to the `cron_jobs` table.
 *
 * The column is a nullable, free-form trust declaration for a schedule's
 * LLM escalation: `"guardian"` (the escalation can act) or `"restricted"`
 * (read/notify only). A null column is treated as `"restricted"` — the
 * default, current behavior — so no backfill is needed.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddCronJobsTrustLevel(database: DrizzleDb): void {
  if (!tableHasColumn(database, "cron_jobs", COLUMN_NAME)) {
    database.run(`ALTER TABLE cron_jobs ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
