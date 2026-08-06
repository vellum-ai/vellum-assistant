import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";

interface ResolveBootstrappedConversationIdArgs {
  queryParamKey: string | null;
  onboardingDraftConversationId?: string | null;
  /**
   * Client-minted draft key for platforms that cold-launch into a new chat
   * (the native mobile shells), supplied only while nothing is selected yet
   * (see `shouldMintNewChatDraft`). Absent everywhere else.
   */
  newChatDraftConversationId?: string | null;
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

/**
 * Mint a client-side conversation key for a chat that does not exist yet, and
 * record it as a draft.
 *
 * Registering here rather than at each call site keeps the two in lockstep:
 * every path that invents a key (cold launch, new chat, onboarding, voice,
 * app viewer) is minting a draft by definition, so none of them can forget.
 */
export function createDraftConversationId(): string {
  const conversationId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : // crypto.randomUUID is ubiquitous in modern browsers, but guard for edge
        // cases (older Safari / non-secure context) so draft creation does not
        // hard-crash.
        `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  useConversationStore.getState().registerDraftConversationId(conversationId);
  return conversationId;
}

interface ShouldMintNewChatDraftArgs {
  /** True on platforms that cold-launch into a new chat. */
  platformStartsInNewChat: boolean;
  urlConversationId: string | null;
  currentConversationId: string | null;
}

/**
 * Whether the bootstrap should mint a fresh draft key for a platform that
 * cold-launches into a new chat.
 *
 * True only while nothing is selected in the URL or the conversation store,
 * which is the cold-launch pass. Once a key is selected (including one a deep
 * link just navigated to) the draft is withheld, so the bootstrap resolves the
 * existing selection instead of replacing the route with an empty composer.
 */
export function shouldMintNewChatDraft({
  platformStartsInNewChat,
  urlConversationId,
  currentConversationId,
}: ShouldMintNewChatDraftArgs): boolean {
  return (
    platformStartsInNewChat &&
    urlConversationId == null &&
    currentConversationId == null
  );
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
  if (!conversation) {
    return false;
  }
  // Surfaced conversations (`surfacedAt != null`) render in Recents even
  // when their underlying type is background/scheduled, so restoring them
  // on reload is expected — the user can see and select them in the sidebar.
  if (conversation.surfacedAt != null) {
    return true;
  }
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
 * conversations require an explicit URL selection. A new-chat draft key, when
 * supplied, replaces both resume fallbacks so the platform lands on an empty
 * composer instead.
 *
 * Precedence, highest first:
 *   1. `queryParamKey` (explicit URL selection)
 *   2. `onboardingDraftConversationId`
 *   3. `currentConversationId` (same-assistant in-memory selection)
 *   4. `newChatDraftConversationId`
 *   5. `storedConversationId` (last viewed, if still selectable)
 *   6. `defaultConversationId`
 */
export function resolveBootstrappedConversationId({
  queryParamKey,
  onboardingDraftConversationId,
  newChatDraftConversationId,
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

  if (newChatDraftConversationId) {
    return newChatDraftConversationId;
  }

  if (
    storedConversationId &&
    isStoredConversationSelectable(conversations, storedConversationId)
  ) {
    return storedConversationId;
  }

  return defaultConversationId;
}
