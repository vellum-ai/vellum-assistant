import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add a nullable `inference_profile TEXT` column to `cron_jobs`.
 *
 * Stores the `llm.profiles` key a schedule's LLM-executed runs should use as
 * their per-turn inference-profile override. `NULL` (all pre-existing rows)
 * means no override — runs resolve through the default `mainAgent` call-site
 * configuration, exactly as before this migration.
 *
 * Idempotent — the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateScheduleInferenceProfile(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("inference_profile")) {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN inference_profile TEXT`);
  }
}
