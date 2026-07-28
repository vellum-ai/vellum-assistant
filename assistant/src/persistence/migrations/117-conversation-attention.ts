import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Conversation attention tables: append-only evidence log and single-row
 * projection for tracking whether users have seen the latest assistant message.
 */
export function createConversationAttentionTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_attention_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      assistant_id TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      confidence TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_text TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      observed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_conv_observed ON conversation_attention_events(conversation_id, observed_at DESC)`,
  );
  if (
    tableHasColumn(database, "conversation_attention_events", "assistant_id")
  ) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_assistant_observed ON conversation_attention_events(assistant_id, observed_at DESC)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_observed ON conversation_attention_events(observed_at)`,
    );
  }
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_events_channel_observed ON conversation_attention_events(source_channel, observed_at DESC)`,
  );

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_assistant_attention_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      assistant_id TEXT NOT NULL,
      latest_assistant_message_id TEXT,
      latest_assistant_message_at INTEGER,
      last_seen_assistant_message_id TEXT,
      last_seen_assistant_message_at INTEGER,
      last_seen_event_at INTEGER,
      last_seen_confidence TEXT,
      last_seen_signal_type TEXT,
      last_seen_source_channel TEXT,
      last_seen_source TEXT,
      last_seen_evidence_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (
    tableHasColumn(
      database,
      "conversation_assistant_attention_state",
      "assistant_id",
    )
  ) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_assistant_latest_msg ON conversation_assistant_attention_state(assistant_id, latest_assistant_message_at DESC)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_assistant_last_seen ON conversation_assistant_attention_state(assistant_id, last_seen_assistant_message_at DESC)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_latest_msg ON conversation_assistant_attention_state(latest_assistant_message_at)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conv_attn_state_last_seen ON conversation_assistant_attention_state(last_seen_assistant_message_at)`,
    );
  }
}
