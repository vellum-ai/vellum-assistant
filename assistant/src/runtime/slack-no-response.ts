/**
 * The assistant emits a `<no_response/>` sentinel to signal that a turn should
 * produce no user-visible reply. Slack surfaces that begin work on the first
 * deliverable text (the thinking-status indicator and native reply streaming)
 * must not act on a partially-arrived sentinel: a slow stream can surface just
 * `<` or `<no_resp` before the rest lands, and starting on that leaks a stray
 * message that later resolves to empty.
 */

/** Matches a message whose entire content is the sentinel. */
const NO_RESPONSE_ONLY_RE = /^\s*<no_response\s*\/?>\s*$/i;

/** Matches every sentinel occurrence for stripping it out of mixed content. */
export const NO_RESPONSE_INLINE_RE = /<no_response\s*\/?>/gi;

const NO_RESPONSE_SENTINEL_FORMS = [
  "<no_response/>",
  "<no_response />",
  "<no_response>",
] as const;

/**
 * Whether `text` could still grow into the sentinel — i.e. it is a leading
 * substring of one of its forms. Holding on these keeps a slowly-streamed
 * `<no_response/>` from surfacing as visible partial content.
 */
function isPotentialNoResponsePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.length === 0) return false;
  return NO_RESPONSE_SENTINEL_FORMS.some((sentinel) =>
    sentinel.startsWith(lower),
  );
}

/**
 * Whether `text` carries user-visible content worth acting on now. Returns
 * `false` for empty text, the standalone sentinel, and any prefix that could
 * still complete into one; returns `true` once real content remains after
 * stripping inline sentinels.
 */
export function hasDeliverableAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (NO_RESPONSE_ONLY_RE.test(trimmed)) return false;
  if (isPotentialNoResponsePrefix(trimmed)) return false;
  return trimmed.replace(NO_RESPONSE_INLINE_RE, "").trim().length > 0;
}
