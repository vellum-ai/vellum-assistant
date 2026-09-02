/**
 * The `<no_response/>` sentinel: the cross-service convention for a turn
 * that deliberately produces no user-visible reply.
 *
 * The model emits it, the daemon stamps and strips it, channel delivery
 * suppresses it, and clients hold live-streamed prefixes of it back from
 * display. One definition here keeps every consumer's parsing identical;
 * a hand-rolled copy in any one of them is how the case-sensitivity of a
 * regex drifts.
 */

/** Matches a message whose entire content is the sentinel. */
const NO_RESPONSE_ONLY_RE = /^\s*<no_response\s*\/?>\s*$/i;

/**
 * Whether `text` is nothing but the sentinel: the whole reply is a
 * deliberate non-response, as opposed to real content with an inline
 * sentinel mixed in.
 */
export function isNoResponseOnlyText(text: string): boolean {
  return NO_RESPONSE_ONLY_RE.test(text);
}

/** Matches every sentinel occurrence for stripping it out of mixed content. */
export const NO_RESPONSE_INLINE_RE = /<no_response\s*\/?>/gi;

/**
 * Detection variant without the `g` flag: a `g`-flagged regex is stateful
 * under `.test()` (it resumes from `lastIndex`), so reusing
 * {@link NO_RESPONSE_INLINE_RE} for detection would alternate between
 * matches and misses across calls.
 */
const NO_RESPONSE_MARKER_RE = new RegExp(NO_RESPONSE_INLINE_RE.source, "i");

/** Whether `text` contains the sentinel anywhere. */
export function containsNoResponseMarker(text: string): boolean {
  return NO_RESPONSE_MARKER_RE.test(text);
}

/** Removes every sentinel occurrence, trimming the leftover whitespace. */
export function stripNoResponseMarkers(text: string): string {
  return text.replace(NO_RESPONSE_INLINE_RE, "").trim();
}

const NO_RESPONSE_SENTINEL_FORMS = [
  "<no_response/>",
  "<no_response />",
  "<no_response>",
] as const;

/**
 * Whether `text` could still grow into the sentinel, i.e. it is a leading
 * substring of one of its forms. Holding on these keeps a slowly-streamed
 * `<no_response/>` from surfacing as visible partial content.
 */
export function isPotentialNoResponsePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.length === 0) {
    return false;
  }
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
  if (trimmed.length === 0) {
    return false;
  }
  if (NO_RESPONSE_ONLY_RE.test(trimmed)) {
    return false;
  }
  if (isPotentialNoResponsePrefix(trimmed)) {
    return false;
  }
  return stripNoResponseMarkers(trimmed).length > 0;
}
