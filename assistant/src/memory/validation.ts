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
 * `(x + 1) / 2`, then clamp. Used by hybrid retrieval (v2) and legacy
 * semantic search to put dense and sparse channels on the same scale
 * before fusion.
 */
export function mapCosineToUnit(value: number): number {
  return clampUnitInterval((value + 1) / 2);
}
