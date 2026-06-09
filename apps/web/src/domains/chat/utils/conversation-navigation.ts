import type { NavigateFunction } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";

/**
 * Navigate to an existing conversation, resetting subagent state and updating
 * the active conversation in the store.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToConversation(
  navigate: NavigateFunction,
  conversationId: string,
): void {
  haptic.light();
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  useConversationStore.getState().setActiveConversationId(conversationId);
  void navigate(routes.conversation(conversationId));
}

/**
 * Create a fresh draft conversation and navigate to it.
 *
 * Always resets subagent state (a subagent detail panel from a prior
 * conversation must not persist into the new draft). When `silent` is true
 * (e.g. fallback after archiving the active conversation), the haptic tap
 * is suppressed.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToNewConversation(
  navigate: NavigateFunction,
  options?: { silent?: boolean },
): void {
  if (!options?.silent) haptic.light();
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);
  void navigate(routes.conversation(draftId));
  requestComposerFocus();
}
