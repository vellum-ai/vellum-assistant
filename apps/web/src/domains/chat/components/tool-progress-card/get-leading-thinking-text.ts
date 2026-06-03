import type { DisplayContentGroup } from "@/domains/chat/utils/display-content-blocks";

/**
 * Maximum number of characters from the preceding assistant text delta to
 * display as the "thinking" step in the unified tool-progress card.
 */
const MAX_THINKING_TEXT_LENGTH = 160;

/**
 * Trim a text group's content and cap it at {@link MAX_THINKING_TEXT_LENGTH}.
 * Returns `null` when the text is empty after trimming.
 */
function previewText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_THINKING_TEXT_LENGTH) : null;
}

/**
 * Returns the assistant text that immediately precedes the tool-call group at
 * `toolGroupIndex`, trimmed and truncated to {@link MAX_THINKING_TEXT_LENGTH}
 * characters.
 *
 * Returns `null` when:
 * - `toolGroupIndex` is `0` (no preceding group), or
 * - the preceding group is anything other than a text group (e.g. another
 *   tool-call group, a reasoning block, an inline surface), or
 * - the preceding text is empty after trimming.
 *
 * `groups` are the render groups produced by `groupContentBlocks` — the same
 * list the transcript renderer walks — so the caller passes the identical
 * `toolGroupIndex` it uses when rendering the tool-call card. Only looks one
 * step back; does not chain across multiple non-text groups.
 */
export function getLeadingThinkingText(
  groups: readonly DisplayContentGroup[],
  toolGroupIndex: number,
): string | null {
  if (toolGroupIndex <= 0) {
    return null;
  }
  const previous = groups[toolGroupIndex - 1];
  if (!previous || previous.type !== "text") {
    return null;
  }
  return previewText(previous.text);
}

/**
 * Best-effort leading-text extractor for the legacy branch in
 * `TranscriptMessageBody`, where all tool calls render in one group at the top
 * regardless of their position in the content order. Surfaces the first text
 * group (the chronologically earliest assistant text) as the card's reasoning
 * preview when one exists.
 *
 * Returns `null` when the row has no leading text group (it opened with a
 * reasoning block or surface, or has no text at all), or when that text is
 * empty after trimming. Capped at the same {@link MAX_THINKING_TEXT_LENGTH}
 * budget as the interleaved-branch helper.
 */
export function getLegacyLeadingThinkingText(
  groups: readonly DisplayContentGroup[],
): string | null {
  const first = groups[0];
  if (!first || first.type !== "text") {
    return null;
  }
  return previewText(first.text);
}
