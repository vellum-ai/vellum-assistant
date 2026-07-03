import type { DrizzleDb } from "../db-connection.js";

/**
 * Idempotent migration to add indexes on foreign-key and scope columns that
 * lacked them.  messages.conversation_id is a FK used for ON DELETE CASCADE,
 * so the index also speeds up cascading deletes.
 */
export function migrateRemainingTableIndexes(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_scope_id ON memory_item_conflicts(scope_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_id ON memory_summaries(scope_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_conversation_id ON tool_invocations(conversation_id)`,
  );
}
