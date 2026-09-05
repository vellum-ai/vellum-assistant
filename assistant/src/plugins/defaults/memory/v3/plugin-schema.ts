/**
 * The memory-v3 plugin's own schema on the dedicated memory connection
 * (`assistant-memory.db`): the `memory_v3_pools` and
 * `memory_v3_injected_sections` tables, and the `section_key` column of
 * `memory_v3_selections`. Plugin storage is created by the plugin,
 * idempotently and fail-open, never by the global migration chain that gates
 * database readiness: the memory plugin's `init` hook runs every ensure on
 * every boot, and each store runs its own again on the first use of a
 * connection in its process (the memory worker is a separate process). A
 * memory database that cannot be opened therefore degrades the stores to
 * no-ops instead of failing the daemon's readiness.
 *
 * This module touches no connection itself (every ensure takes the raw
 * handle), so tests can stand up the memory-side schema on an in-memory
 * database before installing their connection stubs.
 */

import { getLogger } from "../logging.js";
import type { MemorySqlite } from "../memory-db.js";

const log = getLogger("memory-v3-plugin-schema");

/**
 * Wrap a schema ensure so it runs once per connection in this process:
 * idempotent DDL, fail-open. A failed ensure warns once, with
 * `degradedMessage`, and leaves the statement that follows to fail soft like
 * any other; the connection is tried again on its next use, and a reopened
 * connection is ensured again.
 */
export function ensureOncePerConnection(
  ensure: (memoryRaw: MemorySqlite) => void,
  degradedMessage: string,
): (memoryRaw: MemorySqlite) => void {
  const ensured = new WeakSet<MemorySqlite>();
  let warned = false;
  return (memoryRaw) => {
    if (ensured.has(memoryRaw)) {
      return;
    }
    try {
      ensure(memoryRaw);
      ensured.add(memoryRaw);
    } catch (err) {
      if (!warned) {
        warned = true;
        log.warn({ err }, degradedMessage);
      }
    }
  };
}

/** Add `column`, declared as `type`, to `table` unless it already has it. */
function ensureColumn(
  memoryRaw: MemorySqlite,
  table: string,
  column: string,
  type: string,
): void {
  const columns = memoryRaw
    .query(/*sql*/ `PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) {
    return;
  }
  memoryRaw.exec(/*sql*/ `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

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
  ensureColumn(memoryRaw, SECTIONS_TABLE, "frozen_card_bytes", "INTEGER");
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

const SELECTIONS_TABLE = "memory_v3_selections";

/**
 * Add `section_key` to `memory_v3_selections`, the v3 selection log: the
 * matched section's `sectionKey` (`types.ts`), the identity the inspector
 * resolves a logged selection's section by, beside the `section_title` and
 * `section_ordinal` the table carries from its migrations. The table itself
 * is created on the memory connection by migration 338 (the relocation),
 * which runs before the plugin on every install, so this ensure only adds
 * the column, idempotently, and fails on a connection without the table,
 * which {@link ensureMemoryV3SelectionsSectionKeyOnce} reports and retries
 * on the connection's next use.
 */
export function ensureMemoryV3SelectionsSectionKey(
  memoryRaw: MemorySqlite,
): void {
  ensureColumn(memoryRaw, SELECTIONS_TABLE, "section_key", "TEXT");
}

/** {@link ensureMemoryV3SelectionsSectionKey} once per connection in this
 *  process, for the selection log's writer and its inspector reader. */
export const ensureMemoryV3SelectionsSectionKeyOnce = ensureOncePerConnection(
  ensureMemoryV3SelectionsSectionKey,
  "failed to ensure memory_v3_selections.section_key; selection log degraded",
);
