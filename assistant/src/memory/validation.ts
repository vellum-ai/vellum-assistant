/**
 * Unit interval [0, 1] — used for confidence and importance fields on memory items.
 * Coerces out-of-range numbers to the nearest bound rather than rejecting,
 * since LLM-generated values occasionally exceed the range.
 */

/** Clamp a numeric value to [0, 1]. */
export function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}
