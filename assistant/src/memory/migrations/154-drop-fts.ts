import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop the memory_segment_fts virtual table and its associated triggers.
 *
 * The FTS-based lexical search pipeline has been replaced by Qdrant hybrid
 * search. Keeping the FTS table around wastes disk space and adds write
 * overhead on every segment insert/update/delete.
 */
export function migrateDropMemorySegmentFts(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Drop triggers first — they reference the FTS table.
  raw.exec(/*sql*/ `DROP TRIGGER IF EXISTS memory_segments_ai`);
  raw.exec(/*sql*/ `DROP TRIGGER IF EXISTS memory_segments_ad`);
  raw.exec(/*sql*/ `DROP TRIGGER IF EXISTS memory_segments_au`);

  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_segment_fts`);
}
