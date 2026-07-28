import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Migrate existing tool_invocations table to add FK constraint with ON DELETE CASCADE.
 * SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we rebuild the table.
 * This is idempotent: it checks whether the FK already exists before migrating.
 */
export function migrateToolInvocationsFk(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const row = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_invocations'`,
    )
    .get() as { sql: string } | null;
  if (!row) return; // table doesn't exist yet (will be created above)

  // If the DDL already contains REFERENCES, the FK is in place
  if (row.sql.includes("REFERENCES")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE tool_invocations_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO tool_invocations_new SELECT t.* FROM tool_invocations t
        WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id);
      DROP TABLE tool_invocations;
      ALTER TABLE tool_invocations_new RENAME TO tool_invocations;
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
