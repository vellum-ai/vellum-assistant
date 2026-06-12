/**
 * Recency fresh-set lane.
 *
 * Returns the top-K page slugs by most-recent on-disk modification
 * (`PageIndexEntry.modifiedAt`). The fresh set keeps *just-written* pages in
 * the candidate pool during the window before the other lanes can reach them:
 * a page consolidated minutes ago has no selection history (so frecency can't
 * rank it into the hot set) and a "what happened today?"-shaped message gives
 * the finder lanes nothing lexical to match it on. Recency is exactly the
 * signal those lanes are missing, so it gets its own lane.
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
 * `modifiedAt: 0` and are skipped: they have no on-disk write to be fresh by.
 */

import type { Slug } from "./types.js";

/** The slice of a page-index entry the fresh lane ranks on. */
export interface FreshSetEntry {
  slug: Slug;
  /** File mtime in epoch ms; `0` for synthetic entries (skills, CLI commands). */
  modifiedAt: number;
}

export interface FreshSetOptions {
  /** Maximum number of slugs returned; `0` disables the lane. */
  k: number;
  /** Slugs excluded from the result (core + hot — fresh never duplicates the
   *  rest of the stable prefix). */
  excludeSlugs: Set<string>;
}

/**
 * Compute the top-`k` fresh slugs by file modification time, newest first.
 *
 * Deterministic for fixed inputs: ties break `modifiedAt` desc, then slug asc.
 */
export function computeFreshSet(
  entries: readonly FreshSetEntry[],
  opts: FreshSetOptions,
): Slug[] {
  const { k, excludeSlugs } = opts;
  if (k <= 0) return [];

  return entries
    .filter((entry) => entry.modifiedAt > 0 && !excludeSlugs.has(entry.slug))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || (a.slug < b.slug ? -1 : 1))
    .slice(0, k)
    .map((entry) => entry.slug);
}
