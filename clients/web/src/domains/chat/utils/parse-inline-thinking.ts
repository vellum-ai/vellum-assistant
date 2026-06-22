export type InlineThinkingSegment =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

// <think>/</think> is MiniMax's format; <thinking>/</thinking> is the
// standard format. `<thinking>` never matches the `<think>` needle because
// the needle requires an immediate `>`.
const TAG_PAIRS = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
] as const;

export function containsInlineThinkingTag(text: string): boolean {
  return TAG_PAIRS.some((pair) => text.includes(pair.open));
}

/**
 * Splits assistant text containing inline `<thinking>`/`<think>` reasoning
 * tags (emitted by models that surface reasoning as plain text rather than
 * native thinking blocks) into ordered text / thinking segments. Mirrors the
 * macOS client's `InlineThinkingTagParser` so both clients chunk identically:
 * thinking bodies are trimmed, whitespace-only text segments are dropped, and
 * an unclosed tag treats the remainder as still-streaming thinking. Returns
 * `null` when no tag is present so callers can skip the overhead.
 */
export function parseInlineThinkingTags(
  text: string,
): InlineThinkingSegment[] | null {
  if (!containsInlineThinkingTag(text)) return null;

  const segments: InlineThinkingSegment[] = [];
  const pushText = (chunk: string) => {
    if (chunk.trim()) segments.push({ type: "text", text: chunk });
  };
  const pushThinking = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed) segments.push({ type: "thinking", thinking: trimmed });
  };

  let cursor = 0;
  for (;;) {
    // Find the earliest opening tag of either type from the cursor.
    let openIndex = -1;
    let pair: (typeof TAG_PAIRS)[number] | undefined;
    for (const candidate of TAG_PAIRS) {
      const index = text.indexOf(candidate.open, cursor);
      if (index !== -1 && (openIndex === -1 || index < openIndex)) {
        openIndex = index;
        pair = candidate;
      }
    }
    if (!pair) break;

    pushText(text.slice(cursor, openIndex));

    const bodyStart = openIndex + pair.open.length;
    const closeIndex = text.indexOf(pair.close, bodyStart);
    if (closeIndex === -1) {
      // Unclosed tag: the rest of the text is still-streaming thinking.
      pushThinking(text.slice(bodyStart));
      return segments;
    }
    pushThinking(text.slice(bodyStart, closeIndex));
    cursor = closeIndex + pair.close.length;
  }

  pushText(text.slice(cursor));
  return segments;
}
