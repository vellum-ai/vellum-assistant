import type { Conversation } from "@/types/conversation-types";

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
    "conversationId" | "conversationType" | "groupId" | "surfacedAt"
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

function isStoredConversationSelectable(
  conversations: Pick<
    Conversation,
    "conversationId" | "conversationType" | "groupId" | "surfacedAt"
  >[],
  key: string,
): boolean {
  const conversation = conversations.find(
    (item) => item.conversationId === key,
  );
  // With paginated loading, absence from the loaded pages does not prove
  // the conversation was deleted — it may simply be on a later page. Trust
  // the stored ID; if it no longer exists, the history loader handles the
  // 404 gracefully and lands on a new conversation.
  if (!conversation) return true;
  // Surfaced conversations (`surfacedAt != null`) render in Recents even
  // when their underlying type is background/scheduled, so restoring them
  // on reload is expected — the user can see and select them in the sidebar.
  if (conversation.surfacedAt != null) return true;
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
 * conversation is newest. On a cold load, resume the last persisted key unless
 * it is a known background/scheduled conversation — if the key is absent from
 * the loaded pages, trust it (pagination means absence ≠ deleted).
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
