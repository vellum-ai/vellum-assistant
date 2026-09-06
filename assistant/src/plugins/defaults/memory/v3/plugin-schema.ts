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
 * Every ensure takes the raw handle, and the sections ensure records its
 * one-shot legacy copy in the checkpoint ledger it is handed (the main
 * database's `memory_checkpoints` by default), so tests can stand up the
 * memory-side schema on an in-memory database, with a ledger of their own,
 * before installing their connection stubs.
 */

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
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
 * The durable checkpoint ledger (`memory_checkpoints` on the main
 * connection, `persistence/checkpoints.ts`) the sections ensure records its
 * one-shot legacy copy in: the store hands it the real one, tests a map. A
 * read that throws is an unreadable ledger.
 */
export interface CheckpointLedger {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const memoryCheckpointLedger: CheckpointLedger = {
  get: getMemoryCheckpoint,
  set: setMemoryCheckpoint,
};

/**
 * Checkpoint key recording that the legacy card rows were copied into
 * `memory_v3_injected_sections` once on this database, so no later ensure
 * copies them again (see {@link ensureMemoryV3InjectedSectionsSchema}).
 */
export const SECTIONS_LEGACY_COPY_DONE_KEY =
  "memory_v3_injected_sections:legacy_copy_done";

function legacyCardsTableExists(memoryRaw: MemorySqlite): boolean {
  return (
    memoryRaw
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(LEGACY_CARDS_TABLE) != null
  );
}

/**
 * Create `memory_v3_injected_sections` and its index, then seed it from the
 * card-grain `memory_v3_ever_injected` (the superseded record, relocated to
 * the memory connection by migration 345 and frozen there): every legacy row
 * becomes that page's LEAD entry (`section_key = ''`) at zero bytes, keeping
 * its `injected_at` and `pruned_at`, so in-flight conversations keep their
 * dedup state across the cutover (a frozen card in history is the page's
 * lead plus a TOC, and the lead is what a re-selection of that page without
 * a matched section would inject again). Zero bytes because the card's
 * block is opaque to the section readers (rehydrated verbatim, never parsed
 * or stripped): like a capability row, the entry is dedup-only, never a
 * prune candidate, and never counted in the resident footprint.
 *
 * The copy runs once per database. The first ensure that finds the legacy
 * table copies its rows and records {@link SECTIONS_LEGACY_COPY_DONE_KEY} in
 * `ledger`; every later ensure (each connection of each process) skips the
 * copy on that record, so a conversation whose record the compaction reset
 * or the conversation purge cleared (both delete its legacy rows as well,
 * see {@link deleteLegacyCardRows}) never gets its leads back as entries for
 * blocks that are gone. A ledger that cannot be read skips the copy too,
 * leaving it to a later ensure rather than repeating it, and a copy whose
 * record could not be written is repeated by a later ensure. The DDL is
 * `IF NOT EXISTS` and the copy `INSERT OR IGNORE`, so a repeated copy
 * neither duplicates rows nor overwrites entries the section store has since
 * refreshed. A memory database without the legacy table (a fresh install,
 * or one the relocation has not reached yet) gets the empty table and
 * nothing on record; the copy runs on a later ensure once the legacy rows
 * are there.
 */
export function ensureMemoryV3InjectedSectionsSchema(
  memoryRaw: MemorySqlite,
  ledger: CheckpointLedger = memoryCheckpointLedger,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS ${SECTIONS_TABLE} (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      section_key TEXT NOT NULL,
      injected_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      pruned_at INTEGER,
      PRIMARY KEY (conversation_id, slug, section_key)
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_injected_sections_conv
      ON ${SECTIONS_TABLE} (conversation_id)
  `);

  if (!legacyCardsTableExists(memoryRaw)) {
    return;
  }
  let copied: boolean;
  try {
    copied = ledger.get(SECTIONS_LEGACY_COPY_DONE_KEY) !== null;
  } catch (err) {
    log.warn(
      { err },
      "checkpoint ledger unreadable; the legacy card copy into memory_v3_injected_sections waits for a later ensure",
    );
    return;
  }
  if (copied) {
    return;
  }
  memoryRaw.exec(/*sql*/ `
    INSERT OR IGNORE INTO ${SECTIONS_TABLE}
      (conversation_id, slug, section_key, injected_at, bytes, pruned_at)
    SELECT conversation_id, slug, '', injected_at, 0, pruned_at
    FROM ${LEGACY_CARDS_TABLE}
  `);
  try {
    ledger.set(SECTIONS_LEGACY_COPY_DONE_KEY, "1");
  } catch (err) {
    log.warn(
      { err },
      "copied the legacy card rows into memory_v3_injected_sections but could not record the copy; a later ensure repeats it",
    );
  }
}

/**
 * Delete `conversationId`'s rows from the legacy card table, for the
 * compaction reset that clears the conversation's section record (the
 * conversation purge deletes them through its table list). Without this a
 * copy that runs after the reset (its record lost, or a database the copy
 * has not reached) would bring the conversation's leads back as active
 * entries for blocks compaction stripped. No-op without the table.
 */
export function deleteLegacyCardRows(
  memoryRaw: MemorySqlite,
  conversationId: string,
): void {
  if (!legacyCardsTableExists(memoryRaw)) {
    return;
  }
  memoryRaw
    .query(
      /*sql*/ `DELETE FROM ${LEGACY_CARDS_TABLE} WHERE conversation_id = ?`,
    )
    .run(conversationId);
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
