import type { DrizzleDb } from '../db-connection.js';

/**
 * Add archived_at support for conversations and a companion index.
 * Soft-delete semantics (archive/unarchive) rely on this timestamp.
 */
export function migrateConversationArchiveColumns(database: DrizzleDb): void {
  try {
    database.run(/*sql*/ 'ALTER TABLE conversations ADD COLUMN archived_at INTEGER');
  } catch {
    // Column already exists.
  }

  database.run(
    /*sql*/ 'CREATE INDEX IF NOT EXISTS idx_conversations_archived_at ON conversations(archived_at)',
  );
}

