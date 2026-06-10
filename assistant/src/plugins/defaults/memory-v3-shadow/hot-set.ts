/**
 * Frecency hot-set lane.
 *
 * Scores every page slug in `memory_v3_selections` (all conversations) by its
 * exponentially-decayed selection count and returns the top-K. The hot set is
 * the lane that keeps *seasonally recurrent* pages in the candidate pool even
 * when the current message gives the finder lanes nothing to match on; the
 * curated core set (a separate lane) covers the associative-texture class
 * frecency cannot discriminate.
 *
 * Each selection row contributes `2^(−age / halfLifeMs)` to its slug's score,
 * so a selection exactly one half-life old counts half as much as one made
 * now. Slugs in `excludeSlugs` (the core set) are dropped before the K cut —
 * the hot lane never duplicates core.
 */

import {
  type DrizzleDb,
  getSqliteFrom,
} from "../../../memory/db-connection.js";
import type { Slug } from "./types.js";

export interface HotSetDeps {
  /** Handle to the database containing `memory_v3_selections`. */
  db: DrizzleDb;
}

export interface HotSetOptions {
  /** Maximum number of slugs returned. */
  k: number;
  /** Decay half-life in milliseconds: a selection this old scores 0.5. */
  halfLifeMs: number;
  /** Reference timestamp (ms epoch) ages are measured against. */
  now: number;
  /** Slugs excluded from the result (the core set — hot never duplicates core). */
  excludeSlugs: Set<string>;
}

export interface HotSetEntry {
  slug: Slug;
  score: number;
}

interface SelectionAgeRow {
  slug: string;
  created_at: number;
}

/**
 * Compute the top-`k` hot slugs by exponentially-decayed selection frequency.
 *
 * Deterministic for fixed inputs: ties break score desc, then slug asc. The
 * decay sum runs in TS over `(slug, created_at)` pairs — the selections table
 * is small enough that reading it directly beats pushing the math into SQL.
 */
export function computeHotSet(
  deps: HotSetDeps,
  opts: HotSetOptions,
): HotSetEntry[] {
  const { k, halfLifeMs, now, excludeSlugs } = opts;
  if (k <= 0) return [];

  const rows = getSqliteFrom(deps.db)
    .query(
      /*sql*/ `
      SELECT slug, created_at FROM memory_v3_selections
    `,
    )
    .all() as SelectionAgeRow[];

  const scores = new Map<Slug, number>();
  for (const row of rows) {
    if (excludeSlugs.has(row.slug)) continue;
    // Clamp future-dated rows (clock skew) to "now" rather than letting them
    // score above 1 per selection.
    const age = Math.max(0, now - row.created_at);
    const weight = 2 ** (-age / halfLifeMs);
    scores.set(row.slug, (scores.get(row.slug) ?? 0) + weight);
  }

  return [...scores.entries()]
    .map(([slug, score]) => ({ slug, score }))
    .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1))
    .slice(0, k);
}
