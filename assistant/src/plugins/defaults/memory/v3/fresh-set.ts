/**
 * Recency fresh-set lane.
 *
 * Returns the top-K page slugs by effective recency
 * (`PageIndexEntry.freshAt`: the parsed `origin_date` frontmatter when
 * present, else the file mtime), so origin-dated imports sort by their
 * original chronology instead of their import time. The fresh set keeps
 * *just-written* pages in the candidate pool during the window before the
 * other lanes can reach them: a page consolidated minutes ago has no
 * selection history (so frecency can't rank it into the hot set) and a
 * "what happened today?"-shaped message gives the finder lanes nothing
 * lexical to match it on. Recency is exactly the signal those lanes are
 * missing, so it gets its own lane.
 *
 * Like core and hot, the fresh set is a stable-prefix lane: it is computed at
 * lane init and recomputed only on lane invalidation (the consolidation
 * cadence), so its membership — and therefore the selector's cache-stable
 * prefix — never changes mid-window. Page mtimes move on every consolidation
 * write, which is the same event that invalidates the lanes, so recompute
 * lag is bounded by the consolidation interval.
 *
 * Slugs in `excludeSlugs` (core + hot members) are dropped before the K cut —
 * those pages already sit in the stable prefix, so re-listing them would only
 * spend fresh slots on duplicates. Synthetic capability entries carry
 * `freshAt: null` and are skipped: they have no on-disk write to be fresh by.
 */

import type { Slug } from "./types.js";

/** The slice of a page-index entry the fresh lane ranks on. */
export interface FreshSetEntry {
  slug: Slug;
  /** Effective recency in epoch ms (origin date when declared, else file
   *  mtime); pre-epoch origin dates are valid zero or negative values.
   *  `null` for synthetic entries (skills, CLI commands). */
  freshAt: number | null;
}

export interface FreshSetOptions {
  /** Maximum number of slugs returned; `0` disables the lane. */
  k: number;
  /** Slugs excluded from the result (core + hot — fresh never duplicates the
   *  rest of the stable prefix). */
  excludeSlugs: Set<string>;
}

/**
 * Compute the top-`k` fresh slugs by effective recency, newest first.
 *
 * Deterministic for fixed inputs: ties break `freshAt` desc, then slug asc.
 */
export function computeFreshSet(
  entries: readonly FreshSetEntry[],
  opts: FreshSetOptions,
): Slug[] {
  const { k, excludeSlugs } = opts;
  if (k <= 0) {
    return [];
  }

  return entries
    .filter(
      (entry): entry is FreshSetEntry & { freshAt: number } =>
        entry.freshAt !== null &&
        Number.isFinite(entry.freshAt) &&
        !excludeSlugs.has(entry.slug),
    )
    .sort((a, b) => b.freshAt - a.freshAt || (a.slug < b.slug ? -1 : 1))
    .slice(0, k)
    .map((entry) => entry.slug);
}
