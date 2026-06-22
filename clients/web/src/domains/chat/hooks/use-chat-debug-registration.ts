/**
 * useChatDebugRegistration — wires up the dev-facing `window._vellumDebug.chat`
 * API so DevTools consumers can inspect chat state at any time.
 *
 * Getters read the same state the render path uses: turn state from the
 * turn store, and the `UIContext` straight from `uiContextRef` — the exact
 * object `ChatMainPanel` computes and renders from each frame. Reading
 * the rendered value (rather than recomputing it from raw stores) keeps the
 * debug snapshot tightly coupled to what's actually on screen, so e.g.
 * `thinkingIndicator().progressBadge.visible` can never disagree with the
 * badge the user sees. The API is only called from the console, never during
 * render, so imperative reads add no re-renders.
 */

import type { MutableRefObject } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { type UIContext } from "@/domains/chat/turn-selectors";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatDebugApi } from "@/domains/chat/utils/debug-api";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

export interface UseChatDebugRegistrationOptions {
  assistantId: string | null;
  sanitizedMessagesRef: MutableRefObject<DisplayMessage[]>;
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  transcriptRef: MutableRefObject<TranscriptHandle | null>;
  /** The `UIContext` `ChatMainPanel` computed and rendered from last
   *  frame. `null` until the chat view has rendered once. */
  uiContextRef: MutableRefObject<UIContext | null>;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

/**
 * UIContext reported before `ChatMainPanel` has rendered (or while it is
 * unmounted, e.g. the auto-greet overlay). Nothing is processing or pending
 * in that state, so every gate is off.
 */
const EMPTY_UI_CONTEXT: UIContext = {
  hasStreamingAssistantMessage: false,
  hasStreamingAssistantThinking: false,
  hasPendingSecret: false,
  hasPendingConfirmation: false,
  hasPendingQuestion: false,
  hasPendingContactRequest: false,
  hasUncompletedVisibleSurface: false,
  activeConversationIsProcessing: false,
  hasPendingAssistantResponse: false,
};

export function useChatDebugRegistration({
  assistantId,
  sanitizedMessagesRef,
  transcriptItemsRef,
  transcriptRef,
  uiContextRef,
  reconcileActiveConversation,
}: UseChatDebugRegistrationOptions): void {
  useChatDebugApi({
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    getAssistantId: () => assistantId,
    getTurnState: () => useTurnStore.getState(),
    getUIContext: () => uiContextRef.current ?? EMPTY_UI_CONTEXT,
    getPendingInteractionsSnapshot: () => {
      const state = useInteractionStore.getState();
      return {
        pendingSecret: state.pendingSecret,
        isSubmittingSecret: state.isSubmittingSecret,
        pendingConfirmation: state.pendingConfirmation,
        isSubmittingConfirmation: state.isSubmittingConfirmation,
        pendingContactRequest: state.pendingContactRequest,
        isSubmittingContactRequest: state.isSubmittingContactRequest,
        pendingQuestion: state.pendingQuestion,
        isSubmittingQuestion: state.isSubmittingQuestion,
        isQuestionCardDismissed: state.isQuestionCardDismissed,
        inlineConfirmationToolCallId: state.inlineConfirmationToolCallId,
      };
    },
    getScrollPagination: () => {
      const { transcriptPagination } = useChatSessionStore.getState();
      return {
        hasMore: transcriptPagination.hasMore,
        isLoadingOlder: transcriptPagination.isLoadingOlder,
      };
    },
    reconcileActiveConversation,
  });
}
