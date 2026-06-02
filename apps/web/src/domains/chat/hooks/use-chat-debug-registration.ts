/**
 * useChatDebugRegistration — wires up the dev-facing `window._vellumDebug.chat`
 * API so DevTools consumers can inspect chat state at any time.
 *
 * All getters read store state imperatively via `getState()` — the debug API
 * is only called from the console, never during render, so reactive
 * subscriptions would cause unnecessary re-renders with no visible effect.
 */

import type { MutableRefObject } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { type UIContext } from "@/domains/chat/turn-selectors";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { hasAnyInteractiveSurface, hasPendingAssistantResponse } from "@/domains/chat/utils/chat";
import { useChatDebugApi } from "@/domains/chat/utils/debug-api";
import { useConversationStore } from "@/stores/conversation-store";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

export interface UseChatDebugRegistrationOptions {
  assistantId: string | null;
  sanitizedMessagesRef: MutableRefObject<DisplayMessage[]>;
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  transcriptRef: MutableRefObject<TranscriptHandle | null>;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

/** Build a fresh UIContext by reading all stores imperatively. */
function buildUIContext(): UIContext {
  const { messages } = useChatSessionStore.getState();
  const { activeConversationId, processingConversationIds } = useConversationStore.getState();
  const interactionState = useInteractionStore.getState();
  const isProcessing = activeConversationId != null && processingConversationIds.has(activeConversationId);

  return {
    hasStreamingAssistantMessage: isProcessing && messages.length > 0 && messages[messages.length - 1]?.role === "assistant",
    hasPendingSecret: !!interactionState.pendingSecret,
    hasPendingConfirmation: !!interactionState.pendingConfirmation,
    hasPendingQuestion: !!interactionState.pendingQuestion,
    hasPendingContactRequest: !!interactionState.pendingContactRequest,
    hasUncompletedVisibleSurface: hasAnyInteractiveSurface(messages),
    activeConversationIsProcessing: isProcessing,
    hasPendingAssistantResponse: hasPendingAssistantResponse(messages),
  };
}

export function useChatDebugRegistration({
  assistantId,
  sanitizedMessagesRef,
  transcriptItemsRef,
  transcriptRef,
  reconcileActiveConversation,
}: UseChatDebugRegistrationOptions): void {
  useChatDebugApi({
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    getAssistantId: () => assistantId,
    getTurnState: () => useTurnStore.getState(),
    getUIContext: buildUIContext,
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
