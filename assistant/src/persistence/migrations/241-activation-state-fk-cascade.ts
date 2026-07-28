import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Rebuild activation_state to add a foreign key on conversation_id with
 * ON DELETE CASCADE so rows are cleaned up when their conversation is
 * deleted, matching the pattern of conversation_graph_memory_state and
 * every other conversation-keyed table. SQLite doesn't support
 * ALTER TABLE ADD CONSTRAINT, so we rebuild the table; the INSERT...SELECT
 * filters out any orphan rows already accumulated under the prior schema.
 */
export function migrateActivationStateFkCascade(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const row = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_state'`,
    )
    .get() as { sql: string } | null;
  if (!row) return;
  if (row.sql.includes("ON DELETE CASCADE")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE activation_state_new (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO activation_state_new
        SELECT a.* FROM activation_state a
        WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = a.conversation_id);
      DROP TABLE activation_state;
      ALTER TABLE activation_state_new RENAME TO activation_state;
      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
