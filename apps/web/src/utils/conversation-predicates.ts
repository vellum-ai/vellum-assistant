/**
 * Pure predicates over the `Conversation` type.
 *
 * These are used cross-domain (chat, conversations, logs, settings)
 * to classify conversations for UI gating and action availability.
 */

import type { Conversation } from "@/types/conversation-types";

export function isBackgroundConversation(conversation: Conversation): boolean {
  // Surfaced conversations (`surfacedAt != null`) are explicitly promoted
  // into the Recents grouping, so they get full foreground treatment —
  // unread badges, mark read/unread, next-conversation selection — even
  // though their underlying type is still background/scheduled.
  if (conversation.surfacedAt != null) return false;
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
 */
export function contributesToUnreadCount(conversation: Conversation): boolean {
  return (
    conversation.hasUnseenLatestAssistantMessage === true &&
    !isBackgroundConversation(conversation) &&
    conversation.archivedAt == null
  );
}
