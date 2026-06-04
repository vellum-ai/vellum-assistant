import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Maximum number of characters from the preceding assistant text delta to
 * display as the "thinking" step in the unified tool-progress card.
 */
const MAX_THINKING_TEXT_LENGTH = 160;

/**
 * Resolve a `contentOrder` text entry's id against `textSegments`, trim, and
 * cap at {@link MAX_THINKING_TEXT_LENGTH}. Returns `null` when the segment is
 * missing or empty after trimming. Shared by both leading-thinking helpers.
 */
function resolveSegmentPreview(
  message: DisplayMessage,
  id: string,
): string | null {
  const textSegments = message.textSegments ?? [];
  const numericIdx = parseInt(id, 10);
  const segment = !isNaN(numericIdx) ? textSegments[numericIdx] : undefined;
  const rawText = segment?.trim();
  return rawText ? rawText.slice(0, MAX_THINKING_TEXT_LENGTH) : null;
}

/**
 * Best-effort leading-text extractor for the legacy `contentOrder`-without-
 * tool-entries fallback in `TranscriptMessageBody`. The interleaved branch
 * reads the text segment directly preceding each tool-call group; the legacy
 * branch has no such precise ordering, so we surface the first text segment
 * in `contentOrder` (the chronologically earliest assistant text) as the
 * card's "thinking" preview when one exists.
 *
 * Returns `null` when:
 *  - `contentOrder` is missing or empty (we have no reliable ordering between
 *    the message's text and its tool calls — surfacing arbitrary text would
 *    duplicate content already rendered below the card), or
 *  - the first `contentOrder` entry is not a text entry (the message opened
 *    with a surface or has no leading text at all), or
 *  - the resolved text segment is empty after trimming.
 *
 * Output is capped at the same {@link MAX_THINKING_TEXT_LENGTH} budget as
 * the interleaved-branch helper so both mount sites surface the same
 * preview shape.
 */
export function getLegacyLeadingThinkingText(
  message: DisplayMessage,
): string | null {
  const firstOrderEntry = message.contentOrder?.[0];
  if (firstOrderEntry?.type !== "text") {
    return null;
  }
  return resolveSegmentPreview(message, firstOrderEntry.id);
}
