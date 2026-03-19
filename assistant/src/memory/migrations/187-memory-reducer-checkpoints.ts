import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateMemoryReducerCheckpoints(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const columns = [
    "memory_reduced_through_message_id TEXT",
    "memory_dirty_tail_since_message_id TEXT",
    "memory_last_reduced_at INTEGER",
  ];

  for (const column of columns) {
    try {
      raw.exec(`ALTER TABLE conversations ADD COLUMN ${column}`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
}
