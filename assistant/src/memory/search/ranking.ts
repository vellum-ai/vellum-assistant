/**
 * Logarithmic recency decay (ACT-R inspired).
 *
 * Old formula `1/(1+ageDays)` decays far too aggressively:
 *   - 30 days -> 0.032, 1 year -> 0.003
 *
 * New formula `1/(1+log2(1+ageDays))` preserves long-term recall:
 *   - 1 day -> 0.50, 7 days -> 0.25, 30 days -> 0.17
 *   - 90 days -> 0.15, 1 year -> 0.12, 2 years -> 0.10
 */
export function computeRecencyScore(createdAt: number): number {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + Math.log2(1 + ageDays));
}
