import { type DrizzleDb,getSqliteFrom } from '../db-connection.js';

/**
 * Backfill FTS rows for existing messages when upgrading from a version
 * that did not have the messages_fts virtual table.
 */
export function migrateMessagesFtsBackfill(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const ftsCountRow = raw.query(`SELECT COUNT(*) AS c FROM messages_fts`).get() as { c: number } | null;
  const ftsCount = ftsCountRow?.c ?? 0;
  if (ftsCount > 0) return;

  try {
    raw.exec('BEGIN');
    raw.exec(/*sql*/ `
      INSERT INTO messages_fts(message_id, content)
      SELECT id, content FROM messages
    `);
    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}
