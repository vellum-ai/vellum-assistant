import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-v2-injection-events-migration");

/**
 * Create the memory_v2_injection_events table — an append-only event log of
 * (slug, injected_at) tuples capturing every router selection.
 *
 * This is the data source for the time-decayed injection frequency score
 * that drives tier 2 assignment in memory router v4. Score is computed on
 * read as `Σ exp(-λ × (now - tᵢ))` with `λ = ln(2) / 3 days`, so the table
 * just accumulates raw events; the formula or half-life can change later
 * without losing signal.
 *
 * Backfill: walks existing `memory_v2_activation_logs` and replays each
 * row's router-sourced slugs as historical events. Without backfill the
 * scores would take ~3 half-lives (≈9 days) to reach steady state; with
 * backfill tier 2 assignment has signal from day one.
 *
 * Indexes:
 * - `(slug, injected_at)` for per-slug score reads (the hot path).
 * - `(injected_at)` for time-range pruning later.
 */
export function migrateMemoryV2InjectionEvents(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v2_injection_events (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      injected_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_slug_time
      ON memory_v2_injection_events (slug, injected_at)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_time
      ON memory_v2_injection_events (injected_at)
  `);

  // Bail before backfill on databases that predate memory_v2_activation_logs
  // (migration 234) — there's no historical signal to replay.
  const logsTable = raw
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_activation_logs'`,
    )
    .get();
  if (!logsTable) return;

  // Re-run safety net independent of the checkpoint: if events already
  // exist, do not append duplicates. The step runner normally skips
  // already-applied migrations; this guards the manual-clear path.
  const existing = raw
    .query(`SELECT COUNT(*) as n FROM memory_v2_injection_events`)
    .get() as { n: number };
  if (existing.n > 0) return;

  const rows = raw
    .query(
      `SELECT concepts_json, created_at FROM memory_v2_activation_logs ORDER BY created_at ASC`,
    )
    .all() as Array<{ concepts_json: string; created_at: number }>;
  if (rows.length === 0) return;

  const insert = raw.prepare(
    `INSERT INTO memory_v2_injection_events (slug, injected_at) VALUES (?, ?)`,
  );
  const replay = raw.transaction(
    (events: ReadonlyArray<{ slug: string; t: number }>) => {
      for (const e of events) insert.run(e.slug, e.t);
    },
  );

  const buffer: Array<{ slug: string; t: number }> = [];
  let parseFailures = 0;
  for (const row of rows) {
    let concepts: Array<{ slug?: unknown; source?: unknown }>;
    try {
      concepts = JSON.parse(row.concepts_json) as Array<{
        slug?: unknown;
        source?: unknown;
      }>;
    } catch {
      parseFailures += 1;
      continue;
    }
    if (!Array.isArray(concepts)) continue;
    for (const c of concepts) {
      if (typeof c.slug !== "string") continue;
      // Carry-over entries were not router-selected this turn — exclude.
      if (c.source !== "router") continue;
      buffer.push({ slug: c.slug, t: row.created_at });
    }
  }

  if (buffer.length > 0) replay(buffer);
  log.info(
    { inserted: buffer.length, rowsScanned: rows.length, parseFailures },
    `Backfilled ${buffer.length} injection events from ${rows.length} activation log rows`,
  );
}

export function downMemoryV2InjectionEvents(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_v2_injection_events`);
}
