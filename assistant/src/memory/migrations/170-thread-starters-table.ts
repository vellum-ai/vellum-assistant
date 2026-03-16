import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateCreateThreadStartersTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS thread_starters (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      generation_batch INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      source_memory_kinds TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  // Index for ordering by batch (most recent first)
  try {
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_thread_starters_batch ON thread_starters (generation_batch DESC, created_at DESC)`,
    );
  } catch {
    // Index already exists
  }

  // Add capability category column (nullable for backwards compatibility)
  try {
    raw.exec(/*sql*/ `ALTER TABLE thread_starters ADD COLUMN category TEXT`);
  } catch {
    // Column already exists
  }
}
