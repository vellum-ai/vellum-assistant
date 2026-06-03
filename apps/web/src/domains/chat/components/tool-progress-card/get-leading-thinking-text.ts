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
 * Returns the assistant text delta that immediately precedes the tool-call
 * group at `toolGroupIndex` within `message`, trimmed and truncated to
 * {@link MAX_THINKING_TEXT_LENGTH} characters.
 *
 * Returns `null` when:
 * - `toolGroupIndex` is `0` (no preceding group), or
 * - the preceding `contentOrder` group is anything other than a text
 *   segment (e.g. another tool-call group, an inline surface), or
 * - the preceding text segment is missing or empty after trimming.
 *
 * The "groups" referenced here are the consecutive-toolCall-merged groups
 * built in `transcript-message-body.tsx` from `message.contentOrder`; this
 * util mirrors that grouping so callers can pass the same `toolGroupIndex`
 * they use when rendering tool-call cards.
 *
 * Pure function — no store access, no React. Only looks one step back; does
 * not chain across multiple non-tool groups.
 */
export function getLeadingThinkingText(
  message: DisplayMessage,
  toolGroupIndex: number,
): string | null {
  if (toolGroupIndex <= 0) {
    return null;
  }

  const contentOrder = message.contentOrder;
  if (!contentOrder || contentOrder.length === 0) {
    return null;
  }

  // Rebuild the same merged-group structure as transcript-message-body.tsx
  // so toolGroupIndex lines up with what the renderer sees.
  type ContentGroup =
    | { type: "text"; id: string }
    | { type: "toolCalls"; ids: string[] }
    | { type: "surface"; id: string };

  const groups: ContentGroup[] = [];
  for (const entry of contentOrder) {
    if (entry.type === "toolCall" || entry.type === "tool") {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.type === "toolCalls") {
        lastGroup.ids.push(entry.id);
      } else {
        groups.push({ type: "toolCalls", ids: [entry.id] });
      }
    } else if (entry.type === "text") {
      groups.push({ type: "text", id: entry.id });
    } else if (entry.type === "surface") {
      groups.push({ type: "surface", id: entry.id });
    }
  }

  const previous = groups[toolGroupIndex - 1];
  if (!previous || previous.type !== "text") {
    return null;
  }

  return resolveSegmentPreview(message, previous.id);
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
