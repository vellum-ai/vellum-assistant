import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleScriptColumn(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN script TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
