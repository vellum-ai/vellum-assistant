import type { Database } from "bun:sqlite";

import { type DrizzleDb, getMemorySqlite } from "../db-connection.js";

const TABLE = "memory_v3_injected_sections";
const LEGACY_TABLE = "memory_v3_ever_injected";

/**
 * Create `memory_v3_injected_sections` and its index on the memory
 * connection. Idempotent (`IF NOT EXISTS`): the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. Exported so
 * tests can stand up the memory-side schema without running the legacy copy.
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
      PRIMARY KEY (conversation_id, slug, section_key)
    )
  `);
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
 * page without a matched section would inject again).
 *
 * `memory_v3_ever_injected` stays in place: migrations are append-only and
 * the table is frozen. The sections table supersedes it and nothing reads or
 * writes the legacy table after this step.
 *
 * Idempotent: `IF NOT EXISTS` DDL and an `INSERT OR IGNORE` copy, so a rerun
 * neither duplicates rows nor overwrites entries the section store has since
 * refreshed. Throws when the memory database cannot be opened so the runner
 * records the step as failed and retries it on a later boot rather than
 * checkpointing an empty copy.
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
      (conversation_id, slug, section_key, injected_at, bytes, pruned_at)
    SELECT conversation_id, slug, '', injected_at, bytes, pruned_at
    FROM ${LEGACY_TABLE}
  `);
}
