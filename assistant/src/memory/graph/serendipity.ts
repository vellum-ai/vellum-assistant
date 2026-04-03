// ---------------------------------------------------------------------------
// Memory Graph — Serendipity sampling
//
// Reserves a few retrieval slots for weighted-random picks from the mid-tier
// of scored candidates. Prevents the same memories from always loading and
// creates unexpected associations that can spark new connections.
// ---------------------------------------------------------------------------

import type { ScoredNode } from "./types.js";

/**
 * Sample `reserveSlots` candidates from the 30th–70th percentile band
 * of the scored candidates list (which should already be sorted desc by score).
 *
 * Sampling is weighted: higher-scoring mid-tier nodes are more likely
 * to be picked, but there's genuine randomness.
 *
 * Returns the selected serendipity nodes. The caller should merge these
 * with the deterministically-selected top nodes.
 */
export function sampleSerendipity(
  sortedCandidates: ScoredNode[],
  reserveSlots: number,
): ScoredNode[] {
  if (reserveSlots <= 0 || sortedCandidates.length === 0) return [];

  // Percentile boundaries
  const p30 = Math.floor(sortedCandidates.length * 0.3);
  const p70 = Math.floor(sortedCandidates.length * 0.7);

  // Mid-tier band — skip the top (already selected) and bottom (noise)
  const midTier = sortedCandidates.slice(p30, p70);
  if (midTier.length === 0) return [];

  const slots = Math.min(reserveSlots, midTier.length);

  // Weighted random sampling without replacement
  // Weight = score (higher score within mid-tier = more likely to be picked)
  const selected: ScoredNode[] = [];
  const pool = [...midTier];

  for (let i = 0; i < slots; i++) {
    if (pool.length === 0) break;

    const totalWeight = pool.reduce(
      (sum, c) => sum + Math.max(c.score, 0.01),
      0,
    );
    let random = Math.random() * totalWeight;

    let picked = pool.length - 1; // fallback to last
    for (let j = 0; j < pool.length; j++) {
      random -= Math.max(pool[j].score, 0.01);
      if (random <= 0) {
        picked = j;
        break;
      }
    }

    selected.push(pool[picked]);
    pool.splice(picked, 1);
  }

  return selected;
}
