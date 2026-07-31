import type { DrizzleDb } from "../db-connection.js";

/**
 * Drops the dead `assistant_inbox_conversation_state` table — no production
 * code reads or writes it.
 *
 * Idempotent: DROP TABLE IF EXISTS.
 */
export function migrateDropInboxConversationStateTable(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `DROP TABLE IF EXISTS assistant_inbox_conversation_state`,
  );
}
