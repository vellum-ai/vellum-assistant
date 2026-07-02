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
// replaced by a leading space. The detection helpers normalize surrounding
// whitespace and control bytes so they still recognize those variants.
export const PLACEHOLDER_EMPTY_TURN =
  "\x00__PLACEHOLDER__[empty assistant turn]";
export const PLACEHOLDER_BLOCKS_OMITTED =
  "\x00__PLACEHOLDER__[internal blocks omitted]";

// The bare (null-byte-less) sentinel forms. Membership — after trimming
// surrounding whitespace and control bytes — identifies a sentinel; the same
// forms are the prefix targets for the streaming guard.
const PLACEHOLDER_SENTINEL_BARE_FORMS: readonly string[] = [
  PLACEHOLDER_EMPTY_TURN.slice(1),
  PLACEHOLDER_BLOCKS_OMITTED.slice(1),
];
const PLACEHOLDER_SENTINEL_BARE: ReadonlySet<string> = new Set(
  PLACEHOLDER_SENTINEL_BARE_FORMS,
);

// Strip leading bytes at or below U+0020 — ASCII whitespace and every C0
// control byte, including the `\x00` guard prefix and the leading space a
// control-stripping proxy can leave in its place.
function stripLeadingEdgeNoise(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start += 1;
  return text.slice(start);
}

// Strip that edge noise from both ends.
function stripSentinelEdgeNoise(text: string): string {
  const lead = stripLeadingEdgeNoise(text);
  let end = lead.length;
  while (end > 0 && lead.charCodeAt(end - 1) <= 0x20) end -= 1;
  return lead.slice(0, end);
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

/**
 * True when `text` could still grow into a sentinel — or already is one carrying
 * trailing edge noise. Once whitespace and control bytes are stripped from BOTH
 * edges, the remainder must be a prefix of a bare sentinel: the empty string
 * (pure edge noise) and a complete sentinel (a prefix of itself, so
 * `"<sentinel>\n"`) both qualify and stay held until block stop, where
 * `isPlaceholderSentinelText` drops them. The streaming guard uses this to keep
 * a sentinel — or an echo whose `\x00` guard arrived as whitespace — off the
 * live UI before completion.
 *
 * Genuine content is never withheld: any non-whitespace byte breaks the prefix,
 * extending the trimmed remainder past every bare form, so the buffer flushes.
 */
export function couldBePlaceholderSentinelPrefix(text: string): boolean {
  const normalized = stripSentinelEdgeNoise(text);
  return PLACEHOLDER_SENTINEL_BARE_FORMS.some((form) =>
    form.startsWith(normalized),
  );
}
