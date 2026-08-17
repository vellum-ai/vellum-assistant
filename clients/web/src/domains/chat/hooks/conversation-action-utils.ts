/** Pure helper functions for conversation actions.
 *
 *  Separated from the React hook (`useConversationActions`) so they can
 *  be unit-tested without a component render cycle. */

import type { Conversation } from "@/types/conversation-types";
import { isBackgroundConversation } from "@/utils/conversation-predicates";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
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
  if (stored) {
    return stored;
  }
  // Any external-channel conversation returns to its channel section
  // (bucketed under `system:all`), mirroring the prior Slack-only behavior.
  if (isChannelConversation(conversation)) {
    return "system:all";
  }
  if (shouldReturnToBackground(conversation)) {
    return "system:background";
  }
  if (conversation.conversationType === "scheduled") {
    return "system:scheduled";
  }
  if (conversation.conversationType === "background") {
    return "system:background";
  }
  return "system:all";
}

/**
 * The `surfacedAt` a placement into `groupId` leaves on this conversation.
 *
 * Filing a background or scheduled run somewhere the user reads is a
 * promotion, and the daemon stamps `surfaced_at` in the same write that sets
 * the group (`batchSetConversationPlacement`). The stamp is what carries the
 * visibility: `system:pinned` fails the custom-group arm of
 * `standardListingVisibilitySql` on its `system:` prefix, so a pinned
 * background row reaches the sidebar only because it is surfaced. Moving into
 * `system:background` / `system:scheduled` is the demotion and clears it.
 *
 * The client twin of that write, so an optimistic placement leaves the row in
 * the state the server is about to put it in. Without it, a section filter
 * reading `surfacedAt` gets a different answer from the one the next refetch
 * brings back, and the row visibly moves twice.
 *
 * Only background and scheduled rows are stamped: everything else is already
 * visible, and the existing timestamp is kept so a re-filed row does not have
 * its original promotion time overwritten.
 */
export function resolvePlacementSurfacedAt(
  conversation: Conversation,
  groupId: string,
  now: number,
): number | undefined {
  if (groupId === "system:background" || groupId === "system:scheduled") {
    return undefined;
  }
  const promotes =
    groupId !== "system:all" &&
    (groupId === "system:pinned" || !groupId.startsWith("system:"));
  if (!promotes) {
    return conversation.surfacedAt;
  }
  const isBackgroundOrScheduled =
    conversation.conversationType === "background" ||
    conversation.conversationType === "scheduled";
  if (!isBackgroundOrScheduled) {
    return conversation.surfacedAt;
  }
  return conversation.surfacedAt ?? now;
}
