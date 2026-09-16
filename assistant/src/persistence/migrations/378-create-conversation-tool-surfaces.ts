import type { DrizzleDb } from "../db-connection.js";

const TABLE = "conversation_tool_surfaces";

/**
 * Create `conversation_tool_surfaces`: one row per conversation holding the
 * tool definitions its most recent live turn sent to the provider, keyed by
 * conversation with a content hash so an unchanged surface is never rewritten.
 *
 * Its own table rather than a column on `conversations` because the payload
 * is a JSON array of every tool definition (tens of kilobytes) that only fork
 * wakes read, while `conversations` rows are read whole on every hot path.
 * The row cascades with its conversation, so a deleted conversation leaves
 * no surface behind.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateConversationToolSurfaces(
  database: DrizzleDb,
): void {
  database.run(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
       tools_json TEXT NOT NULL,
       tools_hash TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  );
}
