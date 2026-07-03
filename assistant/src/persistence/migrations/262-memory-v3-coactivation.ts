import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the memory_v3_coactivation table — an append-only log of
 * pass-1 → pass-N co-activation pairs observed during a v3 retrieval loop.
 *
 * Each row records that a page (`target_slug`) first surfaced on a later
 * descent pass was co-selected alongside a page (`source_slug`) that surfaced
 * on pass 1, with `pass_gap` = passOf(target) − passOf(source). This is the
 * raw gradient signal that edge-learning later reconciles into curated-graph
 * edge weights: a source that repeatedly precedes a target across turns is a
 * candidate association. `used` is the usefulness flag (0 here — the loop
 * cannot know whether the target was actually load-bearing for the turn; a
 * later edge-learning pass reconciles it).
 *
 * The table just accumulates raw events; the edge-learning formula or the
 * decay/weighting can change later without losing signal.
 *
 * Indexes:
 * - `(source_slug, target_slug)` for per-pair aggregation (the hot path for
 *   edge-learning reads).
 * - `(created_at)` for time-range pruning later.
 */
export function migrateMemoryV3Coactivation(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_coactivation (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      source_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      pass_gap INTEGER NOT NULL,
      used INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_coactivation_pair
      ON memory_v3_coactivation (source_slug, target_slug)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_coactivation_time
      ON memory_v3_coactivation (created_at)
  `);
}

export function downMemoryV3Coactivation(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_v3_coactivation`);
}
