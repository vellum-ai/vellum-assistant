import type { ConversationNoticeEvent } from "../api/events/conversation-notice.js";

export type PendingConversationNotice = Omit<
  ConversationNoticeEvent,
  "type" | "conversationId"
>;

const MAX_TRACKED_CONVERSATIONS = 256;

const pendingNotices = new Map<
  string,
  Map<string, PendingConversationNotice>
>();

function touchConversation(
  conversationId: string,
): Map<string, PendingConversationNotice> {
  const existing = pendingNotices.get(conversationId);
  if (existing) {
    pendingNotices.delete(conversationId);
    pendingNotices.set(conversationId, existing);
    return existing;
  }
  if (pendingNotices.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = pendingNotices.keys().next().value;
    if (oldest !== undefined) pendingNotices.delete(oldest);
  }
  const next = new Map<string, PendingConversationNotice>();
  pendingNotices.set(conversationId, next);
  return next;
}

export function queueConversationNotice(
  conversationId: string,
  key: string,
  notice: PendingConversationNotice,
): void {
  touchConversation(conversationId).set(key, notice);
}

export function drainConversationNotices(
  conversationId: string,
): ConversationNoticeEvent[] {
  const notices = pendingNotices.get(conversationId);
  if (!notices) return [];
  pendingNotices.delete(conversationId);
  return Array.from(notices.values(), (notice) => ({
    type: "conversation_notice" as const,
    conversationId,
    ...notice,
  }));
}

export function clearConversationNotices(conversationId: string): void {
  pendingNotices.delete(conversationId);
}

export function resetConversationNoticesForTests(): void {
  pendingNotices.clear();
}
