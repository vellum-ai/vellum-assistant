import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Backfill FTS rows for existing memory_segments records when upgrading from a
 * version that may not have had trigger-managed FTS.
 */
export function migrateMemoryFtsBackfill(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const ftsCountRow = raw
    .query(`SELECT COUNT(*) AS c FROM memory_segment_fts`)
    .get() as { c: number } | null;
  const ftsCount = ftsCountRow?.c ?? 0;
  if (ftsCount > 0) return;

  try {
    raw.exec("BEGIN");
    raw.exec(/*sql*/ `
      INSERT INTO memory_segment_fts(segment_id, text)
      SELECT id, text FROM memory_segments
    `);
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
