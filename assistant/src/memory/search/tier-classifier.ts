import type { Candidate } from "./types.js";

export type Tier = 1 | 2 | null;

export interface TieredCandidate extends Candidate {
  tier: Tier;
  /** Human-readable label for the source conversation/summary (e.g. conversation title). */
  sourceLabel?: string;
}

export function classifyTier(score: number): Tier {
  if (score > 0.8) return 1;
  if (score > 0.6) return 2;
  return null;
}

export function classifyTiers(candidates: Candidate[]): TieredCandidate[] {
  return candidates
    .map((c) => ({ ...c, tier: classifyTier(c.finalScore) }))
    .filter((c): c is TieredCandidate & { tier: 1 | 2 } => c.tier != null);
}
