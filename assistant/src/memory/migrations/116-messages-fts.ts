import type { DrizzleDb } from '../db-connection.js';

/**
 * FTS5 virtual table for full-text search over messages.content.
 *
 * Content is stored as raw JSON in the messages table — the FTS tokenizer
 * handles it well enough for keyword search since the structural JSON tokens
 * (type, text, tool_use) are short common words that rarely matter as search
 * terms.  The existing buildExcerpt() in conversation-store handles extracting
 * readable text from JSON for display after matching.
 */
export function createMessagesFts(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      content
    )
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_au
    AFTER UPDATE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
    END
  `);
}
