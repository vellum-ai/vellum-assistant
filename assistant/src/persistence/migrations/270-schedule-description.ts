import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

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

  raw
    .query(
      `UPDATE cron_jobs
       SET description = name
       WHERE created_by <> 'defer' AND description = ''`,
    )
    .run();
}

export function downScheduleDescription(): void {
  // Append-only schema migration; the column and backfill are intentionally kept.
}
