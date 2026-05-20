import type { Conversation } from "@/domains/chat/api/conversations.js";

interface ResolveBootstrappedConversationKeyArgs {
  queryParamKey: string | null;
  onboardingDraftConversationKey?: string | null;
  currentConversationKey: string | null;
  currentAssistantId: string | null;
  nextAssistantId: string;
  storedConversationKey: string | null;
  defaultConversationKey: string;
  conversations: Pick<
    Conversation,
    "conversationKey" | "conversationType" | "groupId"
  >[];
}

export function createDraftConversationKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : // crypto.randomUUID is ubiquitous in modern browsers, but guard for edge
      // cases (older Safari / non-secure context) so draft creation does not
      // hard-crash.
      `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isStoredConversationSelectable(
  conversations: Pick<
    Conversation,
    "conversationKey" | "conversationType" | "groupId"
  >[],
  key: string,
): boolean {
  const conversation = conversations.find(
    (item) => item.conversationKey === key,
  );
  if (!conversation) return false;
  return (
    conversation.conversationType !== "background" &&
    conversation.conversationType !== "scheduled" &&
    conversation.groupId !== "system:background" &&
    conversation.groupId !== "system:scheduled"
  );
}

/**
 * Choose the active conversation when chat context is reloaded.
 *
 * URL state wins because it is explicit and may point at a draft key that is
 * not materialized in the conversation list yet. The onboarding handoff can
 * provide a one-shot draft key so the first post-hatch auto-greet never lands
 * in a stale background conversation. For same-assistant refetches, preserve
 * the in-memory selection so manual refresh does not jump to whatever
 * conversation is newest. On a cold load, resume the last persisted key only if
 * the server still lists it as a foreground conversation; background/scheduled
 * conversations require an explicit URL selection.
 */
export function resolveBootstrappedConversationKey({
  queryParamKey,
  onboardingDraftConversationKey,
  currentConversationKey,
  currentAssistantId,
  nextAssistantId,
  storedConversationKey,
  defaultConversationKey,
  conversations,
}: ResolveBootstrappedConversationKeyArgs): string {
  if (queryParamKey) {
    return queryParamKey;
  }

  if (onboardingDraftConversationKey) {
    return onboardingDraftConversationKey;
  }

  if (currentAssistantId === nextAssistantId && currentConversationKey) {
    return currentConversationKey;
  }

  if (
    storedConversationKey &&
    isStoredConversationSelectable(conversations, storedConversationKey)
  ) {
    return storedConversationKey;
  }

  return defaultConversationKey;
}
