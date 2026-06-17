import type { NavigateFunction } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { getSoundManager } from "@/lib/sounds/sound-manager";

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

export interface NavigateToNewConversationOptions {
  silent?: boolean;
  /** When provided, auto-sends this message in the new conversation. */
  prompt?: string;
}

/**
 * Create a fresh draft conversation and navigate to it.
 *
 * Always resets subagent state (a subagent detail panel from a prior
 * conversation must not persist into the new draft). When `silent` is true
 * (e.g. fallback after archiving the active conversation), the haptic tap
 * is suppressed.
 *
 * When `prompt` is provided, the URL includes a `?prompt=` search param that
 * `useAutoSendEffects` picks up to fire the message once the conversation is
 * mounted.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToNewConversation(
  navigate: NavigateFunction,
  options?: NavigateToNewConversationOptions,
): void {
  if (!options?.silent) {
    haptic.light();
    void getSoundManager().play("new_conversation");
  }
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);

  let path: string = routes.conversation(draftId);
  if (options?.prompt) {
    const params = new URLSearchParams({ prompt: options.prompt });
    path = `${path}?${params.toString()}`;
  }
  void navigate(path);
  requestComposerFocus();
}
