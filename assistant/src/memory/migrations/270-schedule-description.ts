import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_schedule_description_backfill_v1";

export function migrateScheduleDescription(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  try {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    // Column already exists.
  }

  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    raw
      .query(
        `UPDATE cron_jobs
         SET description = name
         WHERE created_by <> 'defer' AND description = ''`,
      )
      .run();
  });
}

export function downScheduleDescription(): void {
  // Append-only schema migration; the column and backfill are intentionally kept.
}
