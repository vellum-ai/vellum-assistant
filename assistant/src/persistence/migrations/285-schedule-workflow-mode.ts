import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add `workflow_name` + `workflow_args_json` columns to `cron_jobs`.
 *
 * These back the new `workflow` schedule mode, which triggers a saved
 * workflow by name on a schedule. Both are nullable and only populated for
 * `mode = 'workflow'` rows; existing schedules stay NULL and unchanged.
 *
 * Idempotent — each ALTER is wrapped so a re-run (column already present)
 * is a no-op.
 */
export function migrateScheduleWorkflowMode(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_name TEXT`);
  } catch {
    /* Column already exists */
  }
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN workflow_args_json TEXT`);
  } catch {
    /* Column already exists */
  }
}
