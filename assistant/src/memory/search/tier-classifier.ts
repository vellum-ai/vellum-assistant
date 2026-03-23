import type { Candidate } from "./types.js";

export type Tier = 1 | 2;

export interface TieredCandidate extends Candidate {
  tier: Tier;
  /** Human-readable label for the source conversation/summary (e.g. conversation title). */
  sourceLabel?: string;
}

/**
 * Map a composite relevance score to an injection tier.
 *
 * Thresholds are intentionally set lower than raw-embedding ceilings because
 * the multiplicative scoring pipeline (semantic × recency × metadata) compresses
 * the effective score range.  Lowering the gates lets moderately-relevant items
 * surface rather than being silently dropped.
 */
export function classifyTier(score: number): Tier | null {
  if (score > 0.6) return 1;
  if (score > 0.4) return 2;
  return null;
}

export function classifyTiers(candidates: Candidate[]): TieredCandidate[] {
  return candidates
    .map((c) => ({ ...c, tier: classifyTier(c.finalScore) }))
    .filter((c): c is TieredCandidate => c.tier != null);
}
