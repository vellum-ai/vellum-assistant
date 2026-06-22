import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `memory_v3_ever_injected` for memory-v3's frozen-card carry: one row
 * per (conversation, page-slug) the v3 injector ever attached as a card.
 * `bytes` is the rendered card size used for resident-footprint accounting;
 * `pruned_at` marks rows the prune valve removed from the live context (rows
 * are never deleted — the record stays auditable, and a pruned page that is
 * re-selected re-injects by clearing `pruned_at`).
 *
 * Idempotent — re-running is a no-op once the table and index exist.
 */
export function migrateAddMemoryV3EverInjected(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_ever_injected (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      injected_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      pruned_at INTEGER,
      PRIMARY KEY (conversation_id, slug)
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_ever_injected_conv
      ON memory_v3_ever_injected (conversation_id)
  `);
}
