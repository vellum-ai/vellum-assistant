import type { Database } from "bun:sqlite";

import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { getLogger } from "../logging.js";

const log = getLogger("memory-v2-injection-events");

/**
 * Half-life of the injection-frequency decay, in milliseconds.
 *
 * Per the memory router v4 spec: a +1 from 3 days ago contributes 0.5; from
 * 6 days ago 0.25. Decoupled from turn volume — busy and quiet days decay
 * at the same wall-clock rate.
 */
export const INJECTION_SCORE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

export const INJECTION_SCORE_LAMBDA =
  Math.log(2) / INJECTION_SCORE_HALF_LIFE_MS;

// Events past 6 half-lives contribute <1.6% each. Reads bound the scan to
// this window so per-slug score computation stays cheap as history grows.
// Migration 326 uses the same window to purge dead rows during relocation.
const READ_WINDOW_MS = 6 * INJECTION_SCORE_HALF_LIFE_MS;

function decayContribution(elapsedMs: number): number {
  return Math.exp(-INJECTION_SCORE_LAMBDA * elapsedMs);
}

/**
 * The dedicated memory connection (`assistant-memory.db`), where
 * `memory_v2_injection_events` lives. `null` when the file cannot be opened
 * — every caller here degrades rather than throwing: the event log is a
 * scoring signal, and losing it must never break routing or a turn.
 */
function memorySqliteOrNull(context: string): Database | null {
  const sqlite = getMemorySqlite();
  if (!sqlite) {
    log.warn(
      { context },
      "memory database unavailable; injection events degraded",
    );
  }
  return sqlite;
}

/**
 * Append one event per slug. Best-effort — a SQLite write must never abort
 * the agent turn on top of a successful routing decision the rest of the
 * caller depends on.
 */
export function recordInjectionEvents(
  slugs: readonly string[],
  injectedAt: number,
): void {
  if (slugs.length === 0) return;
  try {
    const raw = memorySqliteOrNull("recordInjectionEvents");
    if (!raw) return;
    const insert = raw.prepare(
      `INSERT INTO memory_v2_injection_events (slug, injected_at) VALUES (?, ?)`,
    );
    const append = raw.transaction((items: readonly string[]) => {
      for (const slug of items) insert.run(slug, injectedAt);
    });
    append(slugs);
  } catch (err) {
    log.warn(
      { err, slugCount: slugs.length },
      "failed to record injection events; continuing",
    );
  }
}

/**
 * `score(now) = Σᵢ exp(-λ × (now - tᵢ))` over events within READ_WINDOW_MS.
 * Returns 0 when the memory database is unavailable.
 */
export function computeInjectionScore(slug: string, now: number): number {
  const raw = memorySqliteOrNull("computeInjectionScore");
  if (!raw) return 0;
  const cutoff = now - READ_WINDOW_MS;
  const rows = raw
    .query(
      `SELECT injected_at FROM memory_v2_injection_events
        WHERE slug = ? AND injected_at >= ?`,
    )
    .all(slug, cutoff) as Array<{ injected_at: number }>;
  let score = 0;
  for (const row of rows) score += decayContribution(now - row.injected_at);
  return score;
}

/**
 * Batch variant of `computeInjectionScore` — single SQL pass scoped to the
 * requested slugs so tier assignment doesn't issue O(M) queries. Slugs
 * with no events in the read window are omitted from the result; callers
 * should treat a missing entry as score 0. Returns an empty map when the
 * memory database is unavailable, so a degraded connection reads as
 * all-zero scores (tier 2 simply selects nothing).
 */
export function computeInjectionScores(
  slugs: readonly string[],
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  const raw = memorySqliteOrNull("computeInjectionScores");
  if (!raw) return out;
  const cutoff = now - READ_WINDOW_MS;
  const placeholders = slugs.map(() => "?").join(",");
  const rows = raw
    .query(
      `SELECT slug, injected_at FROM memory_v2_injection_events
        WHERE slug IN (${placeholders}) AND injected_at >= ?`,
    )
    .all(...slugs, cutoff) as Array<{ slug: string; injected_at: number }>;
  for (const row of rows) {
    const prev = out.get(row.slug) ?? 0;
    out.set(row.slug, prev + decayContribution(now - row.injected_at));
  }
  return out;
}
