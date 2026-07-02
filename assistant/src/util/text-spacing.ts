/**
 * Boundary-aware text joining.
 *
 * A single assistant turn is emitted as a sequence of text blocks split by
 * tool-call and message boundaries. The model frequently ends one block with a
 * sentence-final period and no trailing whitespace, then opens the next block
 * with a capital letter and no leading whitespace — because from the model's
 * point of view each block is its own response. Concatenating those blocks raw
 * fuses the boundary into `...end.Next...` with the space missing.
 *
 * These helpers insert a single separating space at such a boundary, and only
 * there: when both sides carry a character at the join and neither is already
 * whitespace. Blocks that already supply a boundary space (or are empty) join
 * verbatim, so intra-block token streams — where the model's own spacing is
 * authoritative — are never altered.
 */

/** Whitespace characters that count as an existing join boundary. */
function isJoinWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

/**
 * Whether concatenating `left` + `right` needs a single separating space:
 * true only when both sides have a character at the join and neither of those
 * characters is already whitespace. Returns `false` when either side is empty.
 */
export function needsBoundarySpace(left: string, right: string): boolean {
  const prev = left[left.length - 1];
  const next = right[0];
  return (
    prev !== undefined &&
    next !== undefined &&
    !isJoinWhitespace(prev) &&
    !isJoinWhitespace(next)
  );
}

/**
 * Join text parts, inserting a single space between adjacent parts only when
 * the boundary would otherwise fuse two non-whitespace characters. Parts that
 * already carry a boundary space (or are empty) are joined verbatim.
 */
export function joinWithSpacing(parts: string[]): string {
  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    if (needsBoundarySpace(result, parts[i])) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}
