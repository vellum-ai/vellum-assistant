import { z } from "zod";

/**
 * Unit interval [0, 1] — used for confidence and importance fields on memory items.
 * Coerces out-of-range numbers to the nearest bound rather than rejecting,
 * since LLM-generated values occasionally exceed the range.
 */
const unitInterval = z
  .number()
  .transform((v) => Math.min(1, Math.max(0, v)));

/** Zod schema for validating confidence/importance values on memory items. */
export const memoryItemScores = z.object({
  confidence: unitInterval,
  importance: unitInterval,
});

/** Clamp a numeric value to [0, 1]. */
export function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}
