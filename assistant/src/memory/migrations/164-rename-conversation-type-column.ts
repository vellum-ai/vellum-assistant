import type { DrizzleDb } from "../db-connection.js";

/**
 * Rename the `thread_type` column to `conversation_type` in the conversations
 * table and recreate the index with the new column name.
 */
export function migrateRenameConversationTypeColumn(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations RENAME COLUMN thread_type TO conversation_type`,
    );
  } catch {
    /* already renamed */
  }
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_conversations_thread_type`);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_conversation_type ON conversations(conversation_type)`,
  );
}
