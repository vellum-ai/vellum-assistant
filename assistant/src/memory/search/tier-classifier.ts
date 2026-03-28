import type { Candidate } from "./types.js";

/** Backward-compatible alias — downstream files import this type. */
export type TieredCandidate = Candidate & {
  /** Human-readable label for the source conversation/summary (e.g. conversation title). */
  sourceLabel?: string;
};

const MIN_SCORE_THRESHOLD = 0.2;

/**
 * Filter candidates to those exceeding the minimum relevance threshold.
 * Replaces the former tier 1/tier 2 classification — all surviving candidates
 * are treated equally and ranked by score.
 */
export function filterByMinScore(candidates: Candidate[]): TieredCandidate[] {
  return candidates.filter((c) => c.finalScore > MIN_SCORE_THRESHOLD);
}
