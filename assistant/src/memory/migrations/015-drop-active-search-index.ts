import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-time migration to drop the old idx_memory_items_active_search index so
 * it can be recreated with updated covering columns by the idempotent
 * CREATE INDEX IF NOT EXISTS in db-init.
 */
export function migrateDropActiveSearchIndex(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "drop_active_search_index_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec("BEGIN");
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_active_search`);
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}

/**
 * Recreate the old idx_memory_items_active_search index with its original
 * covering columns (before the migration added status and invalid_at as
 * indexed columns).
 */
export function downDropActiveSearchIndex(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Drop the current index if it exists, then recreate with the old column set.
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_active_search`);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_items_active_search
    ON memory_items(last_seen_at DESC, subject, statement, id, kind, confidence, importance, first_seen_at, scope_id)
    WHERE status = 'active' AND invalid_at IS NULL
  `);
}
