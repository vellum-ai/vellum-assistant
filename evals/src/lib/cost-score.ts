/**
 * Score a run's assistant cost against a target baseline as a 0-1 quality
 * fraction, where higher is better (cheaper relative to the budget).
 *
 * A run at or under the baseline earns full marks; the score then decays
 * linearly to 0 at twice the baseline:
 *
 *   score = clamp01(2 - cost / baseline)
 *
 * so spending the baseline scores 100%, spending 1.5× scores 50%, and
 * spending 2× (or more) scores 0%. Expressing cost on the same 0-1 axis as
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
  return Math.max(0, Math.min(1, 2 - costUsd / baselineUsd));
}
