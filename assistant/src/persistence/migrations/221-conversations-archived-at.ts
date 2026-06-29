import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateConversationsArchivedAt(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN archived_at INTEGER DEFAULT NULL`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_archived_at ON conversations (archived_at)`,
  );
}
