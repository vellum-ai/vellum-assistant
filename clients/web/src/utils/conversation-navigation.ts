import type { NavigateFunction } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { isAppMainView } from "@/stores/pane-state";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

export interface NavigateToConversationOptions {
  /** Anchor the transcript to a specific message on load. */
  messageId?: string;
  /**
   * Suppress the haptic tap. For callers that already fired their own haptic
   * at action start (e.g. fork), so the navigation doesn't double-buzz.
   */
  silent?: boolean;
}

function isNarrowViewport(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * If an app is already on screen on a wide viewport, bind `conversationId`
 * as the chat pane and keep the app in the side-by-side layout instead of
 * dismissing it. Returns true when the app was kept.
 *
 * Narrow viewports have no split layout, so those still fall through to
 * chat. Overlay views (document, tool detail, …) are not apps and are
 * dismissed as before.
 */
export function keepOpenAppBesideConversation(conversationId: string): boolean {
  if (isNarrowViewport()) {
    return false;
  }
  const viewer = useViewerStore.getState();
  if (!isAppMainView(viewer.mainView)) {
    return false;
  }
  if (!viewer.activeAppId && !viewer.openedAppState) {
    return false;
  }
  useConversationStore.getState().setEditingConversationId(conversationId);
  viewer.enterAppEditing();
  return true;
}

/**
 * Bring a conversation on screen. An already-open app on a wide viewport
 * stays put in the side-by-side layout; otherwise the viewer returns to chat.
 */
export function revealConversationView(conversationId: string): void {
  if (!keepOpenAppBesideConversation(conversationId)) {
    useViewerStore.getState().setMainView("chat");
  }
}

/**
 * Navigate to an existing conversation, resetting stale viewer state (main
 * view, subagent / workflow panels, transcript side-panel payloads) and
 * updating the active conversation in the store.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToConversation(
  navigate: NavigateFunction,
  conversationId: string,
  options?: NavigateToConversationOptions,
): void {
  if (!options?.silent) {
    haptic.light();
  }
  revealConversationView(conversationId);
  // Only wipe per-conversation process state on a genuine switch. Wiping on
  // a same-conversation navigation kills the inline cards for subagents
  // that are still running: the store repopulates only from live SSE
  // events, so the spawned entries can't come back mid-run (LUM-2875).
  if (conversationId !== useConversationStore.getState().activeConversationId) {
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
    useViewerStore.getState().clearTranscriptPanelPayloads();
  }
  useConversationStore.getState().setActiveConversationId(conversationId);
  void navigate(
    options?.messageId
      ? routes.conversationAtMessage(conversationId, options.messageId)
      : routes.conversation(conversationId),
  );
}

export interface NavigateToNewConversationOptions {
  silent?: boolean;
  /** When provided, auto-sends this message in the new conversation. */
  prompt?: string;
}

/**
 * Create a fresh draft conversation and navigate to it.
 *
 * Always resets subagent state and the transcript side-panel payloads (a
 * subagent detail or files panel from a prior conversation must not persist
 * into the new draft). When `silent` is true
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
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useViewerStore.getState().clearTranscriptPanelPayloads();
  const draftId = createDraftConversationId();
  revealConversationView(draftId);
  useConversationStore.getState().setActiveConversationId(draftId);

  let path: string = routes.conversation(draftId);
  if (options?.prompt) {
    const params = new URLSearchParams({ prompt: options.prompt });
    path = `${path}?${params.toString()}`;
  }
  void navigate(path);
  requestComposerFocus();
}
