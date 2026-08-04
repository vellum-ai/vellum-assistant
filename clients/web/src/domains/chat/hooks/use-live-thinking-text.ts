import { useMemo } from "react";

import { groupContentBlocks } from "@/domains/chat/transcript/message-content";
import { useTranscriptMessageById } from "@/domains/chat/hooks/use-transcript-message-by-id";

/**
 * Reasoning text for a thinking detail drawer, re-derived from the rendered
 * transcript (server history ⊕ the in-flight turn) on every render so an OPEN
 * drawer streams as `assistant_thinking_delta` events land AND stays whole after
 * the turn commits — instead of freezing the snapshot captured when the drawer
 * was opened.
 *
 * Resolving against the transcript union rather than the live turn alone is
 * load-bearing: when a turn finishes, the live-turn→history handoff drops the
 * committed row from the live turn, so a live-turn-only lookup would miss it the
 * moment the assistant stops and the drawer would fall back to the stale
 * open-time snapshot. The committed reasoning lives on the history row, which the
 * union carries.
 *
 * The drawer target is identified by `(messageId, groupIndex)` plus an optional
 * `thinkingItemIndex`. With no item index the combined reasoning of the whole
 * activity group is returned (the bare "Thought process" panel, whose group
 * holds a single reasoning run); with an item index the matching segment is
 * returned (an in-card "Thinking" pill within a `thinking → tool → thinking`
 * run). Reuses {@link groupContentBlocks} so the panel text cannot drift from
 * the inline activity view it mirrors.
 *
 * Returns `null` when the message or group can't be found (e.g. paged out of the
 * loaded transcript) so callers fall back to the open-time snapshot.
 */
export function useLiveThinkingText(
  messageId: string | undefined,
  groupIndex: number | undefined,
  thinkingItemIndex?: number,
): string | null {
  const message = useTranscriptMessageById(messageId);
  return useMemo(() => {
    if (!message || groupIndex == null) {
      return null;
    }
    const groups = groupContentBlocks(message.contentBlocks ?? [], {
      splitInlineThinking: message.role !== "user",
    });
    const group = groups[groupIndex];
    if (!group || group.type !== "activity") {
      return null;
    }
    const segments = group.items.flatMap((item) =>
      item.type === "thinking" && item.thinking ? [item.thinking] : [],
    );
    if (thinkingItemIndex == null) {
      return segments.join("\n");
    }
    return segments[thinkingItemIndex] ?? null;
  }, [message, groupIndex, thinkingItemIndex]);
}
