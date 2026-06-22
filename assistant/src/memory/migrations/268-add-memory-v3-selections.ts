import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `memory_v3_selections` for memory-v3 working-set persistence:
 * one row per (conversation, turn, page-slug) the v3 retriever selected,
 * tagged with the lane (`source`) that produced it. `pinned` marks slugs
 * carried forward across turns rather than re-selected cold.
 *
 * HISTORICAL NOTE: the working-set carry this table originally backed was
 * removed (selections are current-turn only now; cross-turn persistence lives
 * in the injector's frozen net-new blocks). The table itself is still live —
 * the shadow plugin logs per-turn selections to it and the inspector /
 * `summarizeSelections` read from it.
 *
 * Idempotent — re-running is a no-op once the table and index exist.
 */
export function migrateAddMemoryV3Selections(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_selections (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, turn, slug)
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_selections_conv
      ON memory_v3_selections (conversation_id, turn DESC)
  `);
}
