import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "conversation_participants";

/**
 * Create `conversation_participants`: which principals take part in a
 * conversation, and in what capacity.
 *
 * A conversation with no rows belongs to the guardian alone. Removal is
 * a `removed_at` stamp rather than a delete, so authorship stays
 * attributable after access ends.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateConversationParticipants(
  database: DrizzleDb,
): void {
  const sqlite = getSqliteFrom(database);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
       principal_id TEXT NOT NULL,
       role TEXT NOT NULL,
       added_by TEXT,
       added_at INTEGER NOT NULL,
       removed_at INTEGER,
       PRIMARY KEY (conversation_id, principal_id)
     )`,
  );
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversation_participants_principal
       ON ${TABLE} (principal_id, removed_at)`,
  );
}
