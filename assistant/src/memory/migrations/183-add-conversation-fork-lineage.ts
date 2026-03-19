import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateConversationForkLineage(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const columns = [
    "fork_parent_conversation_id TEXT",
    "fork_parent_message_id TEXT",
  ];

  for (const column of columns) {
    try {
      raw.exec(`ALTER TABLE conversations ADD COLUMN ${column}`);
    } catch {
      // Column already exists — nothing to do.
    }
  }

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_fork_parent_conversation_id ON conversations(fork_parent_conversation_id)`,
  );
}
