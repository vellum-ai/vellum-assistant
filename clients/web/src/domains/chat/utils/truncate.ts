/**
 * Shared `truncate` helper for chat-domain text previews.
 *
 * When `text` exceeds `maxLength`, slices to make room for the ellipsis
 * and appends it.
 *
 * The default ellipsis is the single-character `…` (preferred for tight
 * pill / chip chrome). Pass `"..."` (three dots) to mimic the legacy
 * `tool-call-chip` formatting where a 3-char trailing ellipsis was used.
 */
export function truncate(
  text: string,
  maxLength: number,
  ellipsis: string = "…",
): string {
  if (text.length <= maxLength) {
    return text;
  }
  // Reserve room for the ellipsis so the final string is exactly `maxLength`,
  // or one shorter where the cut would split a surrogate pair: a lone half is
  // an invalid string that strict parsers reject.
  let end = maxLength - ellipsis.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end) + ellipsis;
}
