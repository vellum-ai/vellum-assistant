import { Slug, WorkingSetEntry } from "./types.js";

/**
 * Scores a working-set entry for cap eviction. Lower score = more evictable.
 * This is the pluggable seam for a future salience-weighted policy; the
 * default is plain LRU on `lastSeenTurn`.
 */
export type ScoreFn = (entry: WorkingSetEntry) => number;

/** Default eviction score: least-recently-seen entries evict first. */
function lruScore(entry: WorkingSetEntry): number {
  return entry.lastSeenTurn;
}

export class WorkingSet {
  private entries = new Map<Slug, WorkingSetEntry>();

  constructor(
    private readonly maxPages = 150,
    private readonly evictWindow = 5,
    private readonly scoreFn: ScoreFn = lruScore,
  ) {}

  recordSelection(slug: Slug, turn: number, pinned: boolean): void {
    const existing = this.entries.get(slug);
    this.entries.set(slug, {
      slug,
      selectedAtTurn: existing?.selectedAtTurn ?? turn,
      pinned: existing?.pinned || pinned,
      lastSeenTurn: turn,
    });
  }

  union(): Set<Slug> {
    return new Set(this.entries.keys());
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Prune the working set, in order:
   *   1. Core slugs never belong here — drop any entry whose slug is core.
   *      The section-lane pipeline has no core set, so `coreSlugs` defaults to
   *      empty (no-op); the tree pipeline passed its core slugs here. Stale and
   *      cap eviction semantics are identical either way.
   *   2. Pinned entries never evict.
   *   3. Window eviction: drop a non-pinned entry unseen for more than
   *      `evictWindow` turns.
   *   4. Cap eviction: while over `maxPages`, evict the lowest-scoring
   *      non-pinned entry first (ties broken deterministically).
   */
  evict(currentTurn: number, coreSlugs: Set<Slug> = new Set()): void {
    // 1. Core slugs are owned by core, not the working set.
    for (const slug of this.entries.keys()) {
      if (coreSlugs.has(slug)) {
        this.entries.delete(slug);
      }
    }

    // 2 + 3. Window eviction for stale non-pinned entries.
    for (const [slug, entry] of this.entries) {
      if (
        !entry.pinned &&
        currentTurn - entry.lastSeenTurn > this.evictWindow
      ) {
        this.entries.delete(slug);
      }
    }

    // 4. Cap eviction: evict the lowest-scoring non-pinned entry until the
    // set fits. Sort once (ascending score, then slug for determinism) and
    // walk the candidates.
    if (this.entries.size <= this.maxPages) {
      return;
    }
    const evictable = [...this.entries.values()]
      .filter((entry) => !entry.pinned)
      .sort(
        (a, b) =>
          this.scoreFn(a) - this.scoreFn(b) || (a.slug < b.slug ? -1 : 1),
      );
    for (const entry of evictable) {
      if (this.entries.size <= this.maxPages) {
        break;
      }
      this.entries.delete(entry.slug);
    }
  }
}
