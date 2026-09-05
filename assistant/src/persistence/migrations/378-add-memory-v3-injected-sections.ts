import type { Database } from "bun:sqlite";

import { type DrizzleDb, getMemorySqlite } from "../db-connection.js";

const TABLE = "memory_v3_injected_sections";
const LEGACY_TABLE = "memory_v3_ever_injected";

/**
 * Create `memory_v3_injected_sections` and its index on the memory
 * connection. Idempotent (`IF NOT EXISTS`, and the `frozen_card_bytes`
 * column is added to a table created without it): the dedicated connection
 * itself performs no DDL on open, so this migration owns the schema. Exported
 * so tests can stand up the memory-side schema without running the legacy
 * copy.
 */
export function ensureMemoryV3InjectedSectionsSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
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
    .query(/*sql*/ `PRAGMA table_info(${TABLE})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "frozen_card_bytes")) {
    memoryRaw.exec(
      /*sql*/ `ALTER TABLE ${TABLE} ADD COLUMN frozen_card_bytes INTEGER`,
    );
  }
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_injected_sections_conv
      ON ${TABLE} (conversation_id)
  `);
}

/**
 * Create memory-v3's section-grain injection record on the memory database
 * and seed it from the card-grain `memory_v3_ever_injected`: every legacy row
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
 * `memory_v3_ever_injected` stays in place: migrations are append-only and
 * the table is frozen. The sections table supersedes it and nothing reads or
 * writes the legacy table after this step.
 *
 * Idempotent: `IF NOT EXISTS` DDL, an `INSERT OR IGNORE` copy, and a
 * `frozen_card_bytes` backfill that only fills rows still missing it, so a
 * rerun neither duplicates rows nor overwrites entries the section store has
 * since refreshed. Throws when the memory database cannot be opened so the
 * runner records the step as failed and retries it on a later boot rather
 * than checkpointing an empty copy.
 */
export function migrateAddMemoryV3InjectedSections(_database: DrizzleDb): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      `memory database unavailable: deferring ${TABLE} creation and legacy copy`,
    );
  }

  ensureMemoryV3InjectedSectionsSchema(memoryRaw);

  const legacyExists =
    memoryRaw
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(LEGACY_TABLE) != null;
  if (!legacyExists) {
    return;
  }
  memoryRaw.exec(/*sql*/ `
    INSERT OR IGNORE INTO ${TABLE}
      (conversation_id, slug, section_key, injected_at, bytes, pruned_at,
       frozen_card_bytes)
    SELECT conversation_id, slug, '', injected_at, bytes, pruned_at, bytes
    FROM ${LEGACY_TABLE}
  `);
  memoryRaw.exec(/*sql*/ `
    UPDATE ${TABLE} AS t
    SET frozen_card_bytes = (
      SELECT l.bytes FROM ${LEGACY_TABLE} AS l
      WHERE l.conversation_id = t.conversation_id AND l.slug = t.slug
    )
    WHERE t.section_key = ''
      AND t.frozen_card_bytes IS NULL
      AND EXISTS (
        SELECT 1 FROM ${LEGACY_TABLE} AS l
        WHERE l.conversation_id = t.conversation_id AND l.slug = t.slug
      )
  `);
}
