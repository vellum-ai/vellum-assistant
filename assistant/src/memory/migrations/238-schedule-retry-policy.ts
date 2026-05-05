import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleRetryPolicy(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3`,
    );
  } catch {
    /* Column already exists */
  }
  try {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN retry_backoff_ms INTEGER NOT NULL DEFAULT 60000`,
    );
  } catch {
    /* Column already exists */
  }
}
