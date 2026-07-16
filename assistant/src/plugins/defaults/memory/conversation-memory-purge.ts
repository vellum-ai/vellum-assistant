import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("conversation-memory-purge");

/**
 * Per-conversation memory tables on the dedicated memory connection that a
 * conversation delete must purge. SQLite foreign keys cannot span database
 * files, so the main-DB conversation-delete cascade never reaches these rows;
 * the `conversation-deleted` hook deletes them explicitly instead. Each table
 * keys on `conversation_id`; a table joins this list when it moves to the
 * memory connection.
 */
export const CONVERSATION_KEYED_MEMORY_TABLES: readonly string[] = [
  "memory_v2_activation_logs",
  "memory_recall_logs",
  "memory_v3_selections",
  "activation_sessions",
];

/**
 * Delete the given conversation's rows from every table in
 * {@link CONVERSATION_KEYED_MEMORY_TABLES} on the memory connection.
 *
 * Best-effort: an unavailable memory database no-ops, and one table's failing
 * delete is logged and swallowed so the remaining tables are still purged. A
 * lost purge must never break conversation deletion — for these derived tables
 * a stray orphan row is harmless garbage.
 */
export function purgeConversationMemoryTables(conversationId: string): void {
  const raw = memorySqliteOrNull("purgeConversationMemoryTables");
  if (!raw) {
    return;
  }
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      raw
        .query(`DELETE FROM ${table} WHERE conversation_id = ?`)
        .run(conversationId);
    } catch (err) {
      log.warn(
        { err, conversationId, table },
        "Failed to purge memory table for deleted conversation; continuing",
      );
    }
  }
}
