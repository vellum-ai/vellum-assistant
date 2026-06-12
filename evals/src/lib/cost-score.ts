/**
 * Score a run's assistant cost against a target baseline as a 0-1 quality
 * fraction, where higher is better (cheaper relative to the budget).
 *
 * A run at or under the baseline earns full marks; past the baseline the score
 * decays hyperbolically as the inverse cost ratio:
 *
 *   score = min(1, baseline / cost)
 *
 * so spending the baseline scores 100%, 2× the baseline scores 50%, 4× scores
 * 25%, and so on. The curve approaches but never reaches 0, which keeps a wide,
 * legible dynamic range across realistic cached-turn costs instead of collapsing
 * every over-budget run to a flat 0%. Expressing cost on the same 0-1 axis as
 * quality metrics lets it compose into the run's aggregate score instead of
 * dragging it negative with raw dollar amounts.
 */
export function scoreCostAgainstBaseline(
  costUsd: number,
  baselineUsd: number,
): number {
  if (!(baselineUsd > 0)) {
    return 0;
  }
  if (costUsd <= 0) {
    return 1;
  }
  return Math.min(1, baselineUsd / costUsd);
}
