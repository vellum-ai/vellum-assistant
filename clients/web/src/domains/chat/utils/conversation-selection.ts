import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";
import { isBackgroundConversation } from "@/utils/conversation-predicates";
import { isSidebarVisible } from "@/utils/section-membership";

/** The selections the client already holds, needing no server answer. */
interface PreselectedConversationIdArgs {
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
}

interface ResolveBootstrappedConversationIdArgs extends PreselectedConversationIdArgs {
  /**
   * The last-viewed conversation as the server describes it today, looked
   * up by id, or `null` when nothing was stored or the server no longer has
   * it. One row, not the list: whether it is still selectable is a question
   * about that row alone.
   */
  storedConversation: SelectableConversation | null;
  defaultConversationId: string;
}

/** The fields the resume rule reads off a conversation. */
export type SelectableConversation = Pick<
  Conversation,
  | "conversationId"
  | "conversationType"
  | "groupId"
  | "surfacedAt"
  | "archivedAt"
  | "source"
>;

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

/**
 * Whether a conversation may be landed on implicitly on a cold load, as the
 * resumed last-viewed conversation or as the newest one: it must be visible
 * in the sidebar at all (not archived, not a private legacy row, and in some
 * section: {@link isSidebarVisible}, the client's twin of the daemon's
 * standard listing) and not a background or scheduled run, which live behind
 * a collapsed-by-default section and are selected only by explicit URL.
 */
export function isStoredConversationSelectable(
  conversation: SelectableConversation,
): boolean {
  return (
    isSidebarVisible(conversation) && !isBackgroundConversation(conversation)
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
 * the server still has it as a foreground (or surfaced) conversation, read by
 * id so the decision never waits on the full list; background/scheduled
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
  storedConversation,
  defaultConversationId,
  ...preselected
}: ResolveBootstrappedConversationIdArgs): string {
  const preselectedId = resolvePreselectedConversationId(preselected);
  if (preselectedId) {
    return preselectedId;
  }

  if (
    storedConversation &&
    isStoredConversationSelectable(storedConversation)
  ) {
    return storedConversation.conversationId;
  }

  return defaultConversationId;
}

/**
 * Precedence 1 through 4 of {@link resolveBootstrappedConversationId}: the
 * selections the client already holds. `null` means the landing needs the
 * server (resume last-viewed, else newest), which is what lets the loader
 * decide whether to ask before it asks.
 */
export function resolvePreselectedConversationId({
  queryParamKey,
  onboardingDraftConversationId,
  newChatDraftConversationId,
  currentConversationId,
  currentAssistantId,
  nextAssistantId,
}: PreselectedConversationIdArgs): string | null {
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

  return null;
}
