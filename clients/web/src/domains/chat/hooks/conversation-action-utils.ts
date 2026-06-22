/** Pure helper functions for conversation actions.
 *
 *  Separated from the React hook (`useConversationActions`) so they can
 *  be unit-tested without a component render cycle. */

import type { Conversation } from "@/types/conversation-types";
import { isBackgroundConversation } from "@/utils/conversation-predicates";
import { isSlackConversation } from "@/domains/chat/utils/group-conversations";
import { shouldReturnToBackground } from "@/domains/chat/utils/chat";

/**
 * Find the next conversation to switch to after archiving the given one.
 * Skips archived and background/scheduled conversations so the user lands
 * on a normal foreground chat, never on a background job like "Memory
 * Retrospective".
 */
export function findNextConversationId(
  conversations: Conversation[],
  archivedKey: string,
): string | null {
  return (
    conversations.find(
      (c) =>
        c.conversationId !== archivedKey &&
        c.archivedAt == null &&
        !isBackgroundConversation(c),
    )?.conversationId ?? null
  );
}

/**
 * Resolve the target groupId when unpinning a conversation. Checks the
 * pre-pin cache first, then falls back to type-based heuristics that
 * match the macOS client's behaviour.
 */
export function resolveUnpinGroupId(
  conversation: Conversation,
  prePinGroupIds: Map<string, string | undefined>,
): string {
  const stored = prePinGroupIds.get(conversation.conversationId);
  if (stored) return stored;
  if (isSlackConversation(conversation)) return "system:all";
  if (shouldReturnToBackground(conversation)) return "system:background";
  if (conversation.conversationType === "scheduled") return "system:scheduled";
  if (conversation.conversationType === "background") return "system:background";
  return "system:all";
}
