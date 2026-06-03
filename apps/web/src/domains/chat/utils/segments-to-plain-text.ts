/**
 * Derive a message's flat plain-text body from its ordered text segments.
 *
 * This mirrors the daemon's `joinWithSpacing` (see vellum-assistant
 * `daemon/handlers/shared.ts`): adjacent segments are concatenated, and a
 * single space is inserted between two segments only when neither the end of
 * the left segment nor the start of the right segment is already whitespace.
 * Keeping the two implementations byte-identical means text derived on the
 * client matches the text the daemon would have produced.
 *
 * Mirrors the wire `textSegments: string[]` shape — every entry is a text
 * body, matching the daemon which joins only text parts.
 */
export function segmentsToPlainText(
  segments: string[] | undefined,
): string {
  if (!segments || segments.length === 0) {
    return "";
  }

  const parts = segments;

  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i]![0];
    // Only insert a space when neither side already has whitespace.
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}
