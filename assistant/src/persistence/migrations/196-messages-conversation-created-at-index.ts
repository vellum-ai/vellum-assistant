import type { DrizzleDb } from "../db-connection.js";

export function migrateMessagesConversationCreatedAtIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at ON messages(conversation_id, created_at)`,
  );
}
