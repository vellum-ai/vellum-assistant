import { useMemo } from "react";

import {
  activityItemsToCardData,
  groupContentBlocks,
} from "@/domains/chat/transcript/message-content";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";

/**
 * The ordered card items + tool calls of one activity group, re-derived from
 * the rendered transcript (server history ⊕ the in-flight turn) on every
 * render so an OPEN activity-steps panel streams — new steps append, running
 * steps settle — instead of freezing the snapshot captured when the panel was
 * opened. The group-level sibling of {@link useLiveThinkingText} /
 * {@link useLiveToolCall}, sharing {@link activityItemsToCardData} with the
 * transcript's `MultiActivityGroup` props so the panel cannot drift from the
 * inline view it mirrors.
 *
 * Returns `null` when the message or group can't be found (e.g. paged out of
 * the loaded transcript) so callers fall back to the open-time snapshot.
 */
export function useLiveActivityGroup(
  messageId: string | undefined,
  groupIndex: number | undefined,
): { items: ToolCallCardItem[]; toolCalls: ChatMessageToolCall[] } | null {
  const messages = useTranscriptMessages();
  return useMemo(() => {
    if (!messageId || groupIndex == null) {
      return null;
    }
    const message = messages.find((m) =>
      messageMatchKeys(m).includes(messageId),
    );
    if (!message) {
      return null;
    }
    const groups = groupContentBlocks(message.contentBlocks ?? [], {
      splitInlineThinking: message.role !== "user",
    });
    const group = groups[groupIndex];
    if (!group || group.type !== "activity") {
      return null;
    }
    const { cardItems, toolCalls } = activityItemsToCardData(group.items);
    return { items: cardItems, toolCalls };
  }, [messages, messageId, groupIndex]);
}
