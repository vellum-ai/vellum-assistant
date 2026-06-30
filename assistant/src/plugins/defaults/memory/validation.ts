/**
 * Unit interval [0, 1] — used for confidence and importance fields on memory items.
 * Coerces out-of-range numbers to the nearest bound rather than rejecting,
 * since LLM-generated values occasionally exceed the range.
 */

/** Clamp a numeric value to [0, 1]. */
export function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Map cosine similarity [-1, 1] into the unit interval [0, 1] via
 * `(x + 1) / 2`, then clamp. Single-channel display normalization for the
 * legacy v1 semantic-search path; do **not** use before hybrid fusion —
 * the affine rescale halves pairwise dense differences and shifts ranking
 * toward sparse. Hybrid fusion (`v2/sim.ts`) instead clamps negative
 * cosines to 0 with `Math.max(0, x)` and lets positive cosines pass
 * through unchanged.
 */
export function mapCosineToUnit(value: number): number {
  return clampUnitInterval((value + 1) / 2);
}
