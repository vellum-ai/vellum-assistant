import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { groupContentBlocks } from "@/domains/chat/transcript/message-content";

/**
 * Live reasoning text for a thinking detail drawer, re-derived from the
 * chat-session store on every render so an OPEN drawer streams as
 * `assistant_thinking_delta` events land — instead of freezing the snapshot
 * captured when the drawer was opened.
 *
 * The drawer target is identified by `(messageId, groupIndex)` plus an optional
 * `thinkingItemIndex`. With no item index the combined reasoning of the whole
 * activity group is returned (the bare "Thought process" panel, whose group
 * holds a single reasoning run); with an item index the matching segment is
 * returned (an in-card "Thinking" pill within a `thinking → tool → thinking`
 * run). Reuses {@link groupContentBlocks} so the panel text cannot drift from
 * the inline activity view it mirrors.
 *
 * Returns a primitive string so Zustand's `Object.is` comparison re-renders the
 * caller only when the text actually grows. Returns `null` when the message or
 * group can't be found (e.g. paged out of the transcript) so callers fall back
 * to the open-time snapshot.
 */
export function useLiveThinkingText(
  messageId: string | undefined,
  groupIndex: number | undefined,
  thinkingItemIndex?: number,
): string | null {
  return useChatSessionStore((s) => {
    if (!messageId || groupIndex == null) return null;
    const message = s.liveTurn.find(
      (m) => m.id === messageId || m.mergedMessageIds?.includes(messageId),
    );
    if (!message) return null;
    const groups = groupContentBlocks(message.contentBlocks ?? [], {
      splitInlineThinking: message.role !== "user",
    });
    const group = groups[groupIndex];
    if (!group || group.type !== "activity") return null;
    const segments = group.items.flatMap((item) =>
      item.type === "thinking" && item.thinking ? [item.thinking] : [],
    );
    if (thinkingItemIndex == null) return segments.join("\n");
    return segments[thinkingItemIndex] ?? null;
  });
}
