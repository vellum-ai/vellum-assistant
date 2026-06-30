// Internal placeholder sentinels injected as assistant-message content when a
// turn would otherwise serialize with neither text nor tool calls. Provider
// request bodies must keep a non-empty content slot (Anthropic to preserve
// role alternation; strict OpenAI-compatible backends to satisfy the
// "content or tool_calls must be set" constraint), but these markers must
// never be persisted or rendered to users.
//
// The null-byte prefix is intended to make the prefixed form unforgeable by
// normal model output or user input. Some backends reject control characters in
// message content (the OpenAI path emits the bare, prefix-stripped form), and
// some Anthropic-compatible proxies echo the marker back with the `\x00`
// replaced by a leading space. `isPlaceholderSentinelText` normalizes
// surrounding whitespace and control bytes so it still recognizes those
// variants.
export const PLACEHOLDER_EMPTY_TURN =
  "\x00__PLACEHOLDER__[empty assistant turn]";
export const PLACEHOLDER_BLOCKS_OMITTED =
  "\x00__PLACEHOLDER__[internal blocks omitted]";

// Compared against the payload with surrounding whitespace and control bytes
// stripped, so the check matches the prefixed sentinel we emit, the bare
// variant that lost the null byte in transit, and an echo whose `\x00` guard
// arrived as a leading space.
const PLACEHOLDER_SENTINEL_BARE: ReadonlySet<string> = new Set([
  PLACEHOLDER_EMPTY_TURN.slice(1),
  PLACEHOLDER_BLOCKS_OMITTED.slice(1),
]);

/**
 * Strip leading and trailing "edge noise" — any byte at or below U+0020, which
 * covers ASCII whitespace and every C0 control byte, including the `\x00` guard
 * prefix and the leading space a control-stripping proxy can leave in its place.
 */
function stripSentinelEdgeNoise(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}

/**
 * True when the text is one of the internal alternation-preserving sentinels,
 * ignoring surrounding whitespace and control bytes (including the `\x00` guard
 * prefix). These must never be persisted or rendered to users — they exist only
 * in outbound provider request bodies. The match stays exact on the trimmed
 * value, so text that merely contains a sentinel is not flagged.
 */
export function isPlaceholderSentinelText(text: string): boolean {
  return PLACEHOLDER_SENTINEL_BARE.has(stripSentinelEdgeNoise(text));
}
