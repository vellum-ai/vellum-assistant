import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleScriptTimeout(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER`);
  } catch {
    /* Column already exists */
  }
}
