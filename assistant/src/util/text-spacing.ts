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

/**
 * Separator between two messages one model response delivered.
 *
 * A paragraph break, not a space: the model sends several `send_user_message`
 * calls because it means several messages, and the live stream renders them
 * apart until reconciliation replaces them with the joined text. Joining with
 * a space made the row collapse onto one line the moment the turn completed.
 */
export const DELIVERED_MESSAGE_SEPARATOR = "\n\n";

/**
 * Join the messages one response delivered, one paragraph each.
 *
 * Both the live emission in the agent loop and the persisted projection call
 * this, so the streamed text and the text a reload renders are byte-identical
 * and the web's local/server comparison still matches. The result stays ONE
 * text block, so a channel that reconciles against the delivered segment count
 * still sees exactly one segment.
 */
export function joinDeliveredMessages(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(DELIVERED_MESSAGE_SEPARATOR);
}
