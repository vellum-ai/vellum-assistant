import type { DrizzleDb } from "../db-connection.js";
import { migrateExtConvBindingsChannelChatUnique } from "./010-ext-conv-bindings-channel-chat-unique.js";

/**
 * External conversation bindings table with indexes and unique constraint migration.
 */
export function createExternalConversationBindingsTables(
  database: DrizzleDb,
): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS external_conversation_bindings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
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
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel ON external_conversation_bindings(source_channel)`,
  );

  migrateExtConvBindingsChannelChatUnique(database);
}
