import type { DrizzleDb } from "../db-connection.js";

export function migrateConversationsThreadTypeIndex(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_thread_type ON conversations(thread_type)`,
  );
}
