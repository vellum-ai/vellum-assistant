import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add last_message_at denormalized column to conversations for sorting by
 * latest message timestamp instead of updatedAt (which is bumped by non-message
 * events like title changes and context compaction).
 *
 * Idempotent — uses ALTER TABLE try/catch and IF NOT EXISTS guards.
 */
export function migrateConversationsLastMessageAt(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec(`ALTER TABLE conversations ADD COLUMN last_message_at INTEGER`);
  } catch {
    // Column already exists
  }

  // Backfill from the latest message in each conversation.
  // Idempotent: re-running produces the same result.
  raw.exec(`
    UPDATE conversations
    SET last_message_at = (
      SELECT MAX(created_at) FROM messages
      WHERE messages.conversation_id = conversations.id
    )
    WHERE last_message_at IS NULL
  `);

  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
    ON conversations(last_message_at)
  `);
}
