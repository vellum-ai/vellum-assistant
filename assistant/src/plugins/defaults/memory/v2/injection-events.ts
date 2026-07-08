import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { getSqliteFrom } from "../../../../persistence/db-connection.js";
import { getLogger } from "../../../../util/logger.js";

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
const READ_WINDOW_MS = 6 * INJECTION_SCORE_HALF_LIFE_MS;

function decayContribution(elapsedMs: number): number {
  return Math.exp(-INJECTION_SCORE_LAMBDA * elapsedMs);
}

/**
 * Append one event per slug. Best-effort — a SQLite write must never abort
 * the agent turn on top of a successful routing decision the rest of the
 * caller depends on.
 */
export function recordInjectionEvents(
  database: DrizzleDb,
  slugs: readonly string[],
  injectedAt: number,
): void {
  if (slugs.length === 0) return;
  try {
    const raw = getSqliteFrom(database);
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

/** `score(now) = Σᵢ exp(-λ × (now - tᵢ))` over events within READ_WINDOW_MS. */
export function computeInjectionScore(
  database: DrizzleDb,
  slug: string,
  now: number,
): number {
  const cutoff = now - READ_WINDOW_MS;
  const raw = getSqliteFrom(database);
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
 * should treat a missing entry as score 0.
 */
export function computeInjectionScores(
  database: DrizzleDb,
  slugs: readonly string[],
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  const cutoff = now - READ_WINDOW_MS;
  const raw = getSqliteFrom(database);
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
