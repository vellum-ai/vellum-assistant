/**
 * Pure predicates over the `Conversation` type.
 *
 * These are used cross-domain (chat, conversations, logs, settings)
 * to classify conversations for UI gating and action availability.
 */

import type { Conversation } from "@/types/conversation-types";

export function isBackgroundConversation(conversation: Conversation): boolean {
  return (
    conversation.conversationType === "background" ||
    conversation.conversationType === "scheduled" ||
    conversation.groupId === "system:background" ||
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
