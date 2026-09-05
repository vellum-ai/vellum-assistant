/**
 * The memory-v3 plugin's own tables on the dedicated memory connection
 * (`assistant-memory.db`): `memory_v3_pools` and
 * `memory_v3_injected_sections`. Plugin storage is created by the plugin,
 * idempotently and fail-open, never by the global migration chain that gates
 * database readiness: the memory plugin's `init` hook runs both ensures on
 * every boot, and each store runs its own again on the first use of a
 * connection in its process (the memory worker is a separate process). A
 * memory database that cannot be opened therefore degrades the stores to
 * no-ops instead of failing the daemon's readiness.
 *
 * This module touches no connection itself (it takes the raw handle), so
 * tests can stand up the memory-side schema on an in-memory database before
 * installing their connection stubs.
 */

import type { MemorySqlite } from "../memory-db.js";

/**
 * Create `memory_v3_pools` and its indexes. One row per `(conversation,
 * turn)`: the memory-v3 selector's full candidate pool for that turn
 * (stable-prefix cards and finder lines, in pool order) with each
 * candidate's verdict, serialized as JSON in `candidates_json`, and
 * `selector_ran` (0 for a turn whose selector never judged a pool, which is
 * persisted as an empty pool). Idempotent (`IF NOT EXISTS`).
 */
export function ensureMemoryV3PoolsSchema(memoryRaw: MemorySqlite): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_pools (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      pool_size INTEGER NOT NULL,
      selected_count INTEGER NOT NULL,
      selector_ran INTEGER NOT NULL DEFAULT 1,
      candidates_json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, turn)
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_pools_message
      ON memory_v3_pools (message_id)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_pools_conv
      ON memory_v3_pools (conversation_id, turn DESC)
  `);
}

const SECTIONS_TABLE = "memory_v3_injected_sections";
const LEGACY_CARDS_TABLE = "memory_v3_ever_injected";

/**
 * Create `memory_v3_injected_sections` and its index, then seed it from the
 * card-grain `memory_v3_ever_injected` (the superseded record, relocated to
 * the memory connection by migration 345 and frozen there): every legacy row
 * becomes that page's LEAD entry (`section_key = ''`), keeping its
 * `injected_at`, `bytes`, and `pruned_at`, so in-flight conversations keep
 * their dedup and prune state across the cutover (a frozen card in history is
 * the page's lead plus a TOC, and the lead is what a re-selection of that
 * page without a matched section would inject again). The legacy `bytes`,
 * the length the card injector measured for the whole frozen card, is also
 * kept as `frozen_card_bytes`, which a later re-injection never refreshes:
 * it is the block parser's boundary evidence for the card still sitting in
 * that message's metadata.
 *
 * Idempotent: `IF NOT EXISTS` DDL, the `frozen_card_bytes` column added to a
 * table created without it, an `INSERT OR IGNORE` copy, and a
 * `frozen_card_bytes` backfill that only fills rows still missing it, so a
 * rerun neither duplicates rows nor overwrites entries the section store has
 * since refreshed. A memory database without the legacy table (a fresh
 * install, or one the relocation has not reached yet) gets the empty table;
 * the copy runs on a later ensure once the legacy rows are there.
 */
export function ensureMemoryV3InjectedSectionsSchema(
  memoryRaw: MemorySqlite,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS ${SECTIONS_TABLE} (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      section_key TEXT NOT NULL,
      injected_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      pruned_at INTEGER,
      frozen_card_bytes INTEGER,
      PRIMARY KEY (conversation_id, slug, section_key)
    )
  `);
  const columns = memoryRaw
    .query(/*sql*/ `PRAGMA table_info(${SECTIONS_TABLE})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "frozen_card_bytes")) {
    memoryRaw.exec(
      /*sql*/ `ALTER TABLE ${SECTIONS_TABLE} ADD COLUMN frozen_card_bytes INTEGER`,
    );
  }
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_injected_sections_conv
      ON ${SECTIONS_TABLE} (conversation_id)
  `);

  const legacyExists =
    memoryRaw
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(LEGACY_CARDS_TABLE) != null;
  if (!legacyExists) {
    return;
  }
  memoryRaw.exec(/*sql*/ `
    INSERT OR IGNORE INTO ${SECTIONS_TABLE}
      (conversation_id, slug, section_key, injected_at, bytes, pruned_at,
       frozen_card_bytes)
    SELECT conversation_id, slug, '', injected_at, bytes, pruned_at, bytes
    FROM ${LEGACY_CARDS_TABLE}
  `);
  memoryRaw.exec(/*sql*/ `
    UPDATE ${SECTIONS_TABLE} AS t
    SET frozen_card_bytes = (
      SELECT l.bytes FROM ${LEGACY_CARDS_TABLE} AS l
      WHERE l.conversation_id = t.conversation_id AND l.slug = t.slug
    )
    WHERE t.section_key = ''
      AND t.frozen_card_bytes IS NULL
      AND EXISTS (
        SELECT 1 FROM ${LEGACY_CARDS_TABLE} AS l
        WHERE l.conversation_id = t.conversation_id AND l.slug = t.slug
      )
  `);
}
