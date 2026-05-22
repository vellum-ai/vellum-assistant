/**
 * Shared `truncate` helper for chat-domain text previews.
 *
 * Consolidates three formerly-local copies that lived in
 * `tool-call-chip/utils.ts`, `tool-progress-card/derive-step-label.ts`, and
 * `use-subagent-card-data.ts` (as `trimTextPreview`). Behaviour matches the
 * common case: when `text` exceeds `maxLength`, slice to make room for the
 * ellipsis and append it.
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
  if (text.length <= maxLength) return text;
  // Reserve room for the ellipsis so the final string is exactly `maxLength`.
  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}
