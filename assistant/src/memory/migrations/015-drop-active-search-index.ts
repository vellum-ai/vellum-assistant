import { getSqliteFrom, type DrizzleDb } from '../db-connection.js';

/**
 * One-time migration to drop the old idx_memory_items_active_search index so
 * it can be recreated with updated covering columns by the idempotent
 * CREATE INDEX IF NOT EXISTS in db-init.
 */
export function migrateDropActiveSearchIndex(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'drop_active_search_index_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec('BEGIN');
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_active_search`);
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}
