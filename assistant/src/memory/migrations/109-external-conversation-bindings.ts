import type { DrizzleDb } from "../db-connection.js";

/**
 * External conversation bindings table with indexes.
 */
export function createExternalConversationBindingsTables(
  database: DrizzleDb,
): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS external_conversation_bindings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_chat_name TEXT,
      external_thread_id TEXT,
      external_user_id TEXT,
      display_name TEXT,
      username TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_inbound_at INTEGER,
      last_outbound_at INTEGER
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat ON external_conversation_bindings(source_channel, external_chat_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_thread ON external_conversation_bindings(source_channel, external_chat_id, external_thread_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel ON external_conversation_bindings(source_channel)`,
  );
  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_no_thread_unique
    ON external_conversation_bindings(source_channel, external_chat_id)
    WHERE external_thread_id IS NULL
  `);
  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_thread_unique
    ON external_conversation_bindings(source_channel, external_chat_id, external_thread_id)
    WHERE external_thread_id IS NOT NULL
  `);
}
