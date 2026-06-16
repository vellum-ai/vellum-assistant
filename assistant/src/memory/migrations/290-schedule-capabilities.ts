import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add a nullable `capabilities_json TEXT` column to `cron_jobs`.
 *
 * Persists the capability manifest a scheduled workflow run should execute
 * under. `NULL` (all pre-existing rows) means no persisted manifest — runs
 * fall back to the hardcoded read-only manifest.
 *
 * Idempotent — the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateScheduleCapabilities(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("capabilities_json")) {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN capabilities_json TEXT`);
  }
}
