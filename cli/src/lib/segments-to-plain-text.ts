/**
 * Derive a message's flat plain-text body from its ordered text segments.
 *
 * Mirrors the daemon's `joinWithSpacing` (assistant `daemon/handlers/shared.ts`):
 * adjacent segments are concatenated, inserting a single space between two
 * segments only when neither the end of the left nor the start of the right is
 * already whitespace. Keeping these byte-identical means CLI-rendered text
 * matches what the daemon would have produced for the now-removed flat
 * `content` field.
 */
export function segmentsToPlainText(segments: string[] | undefined): string {
  if (!segments || segments.length === 0) {
    return "";
  }
  let result = segments[0] ?? "";
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const next = segments[i]![0];
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
    result += segments[i];
  }
  return result;
}
