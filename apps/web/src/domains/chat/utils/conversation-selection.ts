import type { QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import { useConversationStore } from "@/stores/conversation-store";
import { prependConversation } from "@/utils/conversation-cache-mutations";

interface ResolveBootstrappedConversationIdArgs {
  queryParamKey: string | null;
  onboardingDraftConversationId?: string | null;
  currentConversationId: string | null;
  currentAssistantId: string | null;
  nextAssistantId: string;
  storedConversationId: string | null;
  defaultConversationId: string;
  conversations: Pick<
    Conversation,
    "conversationId" | "conversationType" | "groupId"
  >[];
}

export function createDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : // crypto.randomUUID is ubiquitous in modern browsers, but guard for edge
      // cases (older Safari / non-secure context) so draft creation does not
      // hard-crash.
      `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Create a local draft conversation: generate an ID, set it as active in
 * the store, and seed a `draft: true` stub in the foreground list cache so
 * `useActiveConversation` never fires a server fetch for it.
 */
export function startDraftConversation(
  queryClient: QueryClient,
  assistantId: string | null,
): string {
  const id = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(id);
  prependConversation(queryClient, assistantId, {
    conversationId: id,
    lastMessageAt: Date.now(),
    draft: true,
  } as Conversation);
  return id;
}

function isStoredConversationSelectable(
  conversations: Pick<
    Conversation,
    "conversationId" | "conversationType" | "groupId"
  >[],
  key: string,
): boolean {
  const conversation = conversations.find(
    (item) => item.conversationId === key,
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
export function resolveBootstrappedConversationId({
  queryParamKey,
  onboardingDraftConversationId,
  currentConversationId,
  currentAssistantId,
  nextAssistantId,
  storedConversationId,
  defaultConversationId,
  conversations,
}: ResolveBootstrappedConversationIdArgs): string {
  if (queryParamKey) {
    return queryParamKey;
  }

  if (onboardingDraftConversationId) {
    return onboardingDraftConversationId;
  }

  if (currentAssistantId === nextAssistantId && currentConversationId) {
    return currentConversationId;
  }

  if (
    storedConversationId &&
    isStoredConversationSelectable(conversations, storedConversationId)
  ) {
    return storedConversationId;
  }

  return defaultConversationId;
}
