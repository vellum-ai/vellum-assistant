import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleQuietFlag(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
