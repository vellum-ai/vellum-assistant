/**
 * Pure predicates over the `Conversation` type.
 *
 * These are used cross-domain (chat, conversations, logs, settings)
 * to classify conversations for UI gating and action availability.
 */

import type { Conversation } from "@/types/conversation-types";

/**
 * True when a `groupId` refers to a non-system (custom) group.
 * System groups use a `"system:"` prefix (e.g. `"system:pinned"`).
 */
export function isCustomGroupId(
  groupId: string | undefined,
): groupId is string {
  return !!groupId && !groupId.startsWith("system:");
}

/**
 * True when a conversation is pinned, via either the modern `isPinned`
 * boolean or the legacy `groupId === "system:pinned"` marker. Some
 * conversations (especially older ones) only carry the legacy marker,
 * so checking `isPinned` alone misses them and shows the wrong
 * Pin/Unpin label in the actions menu.
 */
export function isConversationPinned(conversation: Conversation): boolean {
  return (
    conversation.isPinned === true || conversation.groupId === "system:pinned"
  );
}

export function isBackgroundConversation(conversation: Conversation): boolean {
  // Surfaced conversations (`surfacedAt != null`) are explicitly promoted
  // into the Recents grouping, so they get full foreground treatment —
  // unread badges, mark read/unread, next-conversation selection — even
  // though their underlying type is still background/scheduled.
  if (conversation.surfacedAt != null) {
    return false;
  }
  return (
    conversation.conversationType === "background" ||
    conversation.conversationType === "scheduled" ||
    conversation.groupId === "system:background" ||
    conversation.groupId === "system:scheduled"
  );
}

/**
 * Whether this conversation is a scheduled job specifically (as opposed to
 * the broader background umbrella). Used to keep the scheduled-only cache
 * disjoint from the background-only cache: the daemon's `background` filter
 * still returns scheduled rows for back-compat, so the background list is
 * filtered through `!isScheduledConversation` before it is cached.
 *
 * Unlike `isBackgroundConversation`, this is a *type* classifier, not a
 * foreground-visibility predicate — it intentionally ignores `surfacedAt`.
 * A surfaced scheduled row is still a scheduled job (it stays in the
 * scheduled filtered listing/cache); surfacing only adds Recents visibility.
 */
export function isScheduledConversation(conversation: Conversation): boolean {
  return (
    conversation.conversationType === "scheduled" ||
    conversation.groupId === "system:scheduled"
  );
}

export function canMarkUnread(conversation: Conversation): boolean {
  return (
    !conversation.hasUnseenLatestAssistantMessage &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationId != null &&
    conversation.latestAssistantMessageAt != null
  );
}

export function canMarkRead(conversation: Conversation): boolean {
  return (
    conversation.hasUnseenLatestAssistantMessage === true &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationId != null
  );
}

/**
 * Whether this conversation should be reflected in user-visible unread
 * counters (sidebar attention, Dock badge, etc.). Excludes archived
 * threads and automated background / scheduled threads — those have
 * their own surfaces and don't represent attention the user is
 * expected to clear.
 *
 * The daemon applies the same rules in SQL to serve
 * `GET /v1/conversations/unread-count` (`countUnreadConversations` in
 * `assistant/src/persistence/conversation-queries.ts`). **Changing the rules
 * here means changing them there too**, or the badge and the sidebar's unread
 * dots disagree. `conversation-predicates.test.ts` and the daemon's
 * `conversation-list-routes.test.ts` assert the same scenario matrix on
 * either side of that boundary.
 */
export function contributesToUnreadCount(conversation: Conversation): boolean {
  return (
    conversation.hasUnseenLatestAssistantMessage === true &&
    !isBackgroundConversation(conversation) &&
    conversation.archivedAt == null
  );
}

/**
 * Count the conversations in `conversations` that contribute to unread
 * counters.
 *
 * **Only as complete as the list it is given.** It is the fallback for
 * assistants that do not serve `GET /v1/conversations/unread-count`, and it
 * is correct only while the client holds every conversation. Once the list
 * loads progressively, a partial list yields an under-count, so this must not
 * become the primary source for any surface.
 */
export function countUnreadConversationsInList(
  conversations: readonly Conversation[],
): number {
  return conversations.reduce(
    (total, conversation) =>
      contributesToUnreadCount(conversation) ? total + 1 : total,
    0,
  );
}
