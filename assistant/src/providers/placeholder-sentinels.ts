// Internal placeholder sentinels injected as assistant-message content when a
// turn would otherwise serialize with neither text nor tool calls. Provider
// request bodies must keep a non-empty content slot (Anthropic to preserve
// role alternation; strict OpenAI-compatible backends to satisfy the
// "content or tool_calls must be set" constraint), but these markers must
// never be persisted or rendered to users.
//
// The null-byte prefix makes the prefixed form impossible to produce via
// normal model output or user input, preventing false positives. Some
// OpenAI-compatible backends reject control characters in message content, so
// the OpenAI path emits the bare (prefix-stripped) form, which
// `isPlaceholderSentinelText` still recognizes.
export const PLACEHOLDER_EMPTY_TURN =
  "\x00__PLACEHOLDER__[empty assistant turn]";
export const PLACEHOLDER_BLOCKS_OMITTED =
  "\x00__PLACEHOLDER__[internal blocks omitted]";

// Compared against the payload with any leading `\x00` stripped, so the check
// matches both the prefixed sentinel we emit and any bare variant that lost
// the null byte in transit (e.g. the model echoing the text back without
// reproducing the control character).
const PLACEHOLDER_SENTINEL_BARE: ReadonlySet<string> = new Set([
  PLACEHOLDER_EMPTY_TURN.slice(1),
  PLACEHOLDER_BLOCKS_OMITTED.slice(1),
]);

/**
 * True when the text is one of the internal alternation-preserving sentinels,
 * with or without the null-byte prefix. These must never be persisted or
 * rendered to users — they exist only in outbound provider request bodies.
 */
export function isPlaceholderSentinelText(text: string): boolean {
  const normalized = text.startsWith("\x00") ? text.slice(1) : text;
  return PLACEHOLDER_SENTINEL_BARE.has(normalized);
}
