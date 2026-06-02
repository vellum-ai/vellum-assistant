/**
 * useChatDebugRegistration — wires up the dev-facing `window._vellumDebug.chat`
 * API by combining the UIContext snapshot with the debug API hook.
 *
 * Consolidates the `_debugUiContext` memo, the `getPendingInteractionsSnapshot`
 * callback, and the `useChatDebugApi` call that were scattered in
 * ActiveChatView. The debug API is unconditionally attached (no query-param
 * gating) so it's available in dev, staging, and production.
 */

import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { type UIContext } from "@/domains/chat/turn-selectors";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat";
import { isSurfaceInteractive } from "@/domains/chat/types/types";
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

export function useChatDebugRegistration({
  assistantId,
  sanitizedMessagesRef,
  transcriptItemsRef,
  transcriptRef,
  reconcileActiveConversation,
}: UseChatDebugRegistrationOptions): void {
  const messages = useChatSessionStore.use.messages();
  const transcriptPagination = useChatSessionStore.use.transcriptPagination();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();

  const assistantIdRef = useRef<string | null>(assistantId);
  useEffect(() => { assistantIdRef.current = assistantId; }, [assistantId]);

  const uiContext = useMemo<UIContext>(() => {
    const isProcessing = activeConversationId != null && processingConversationIds.has(activeConversationId);
    const interactionState = useInteractionStore.getState();
    let hasUncompletedSurface = false;
    for (const msg of messages) {
      if (msg.surfaces) {
        for (const s of msg.surfaces) {
          if (isSurfaceInteractive(s)) { hasUncompletedSurface = true; break; }
        }
      }
      if (hasUncompletedSurface) break;
    }
    return {
      hasStreamingAssistantMessage: isProcessing && messages.length > 0 && messages[messages.length - 1]?.role === "assistant",
      hasPendingSecret: !!interactionState.pendingSecret,
      hasPendingConfirmation: !!interactionState.pendingConfirmation,
      hasPendingQuestion: !!interactionState.pendingQuestion,
      hasPendingContactRequest: !!interactionState.pendingContactRequest,
      hasUncompletedVisibleSurface: hasUncompletedSurface,
      activeConversationIsProcessing: isProcessing,
      hasPendingAssistantResponse: hasPendingAssistantResponse(messages),
    };
  }, [messages, activeConversationId, processingConversationIds]);

  useChatDebugApi({
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    getAssistantId: () => assistantIdRef.current,
    getTurnState: () => useTurnStore.getState(),
    getUIContext: () => uiContext,
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
    getScrollPagination: () => ({
      hasMore: transcriptPagination.hasMore,
      isLoadingOlder: transcriptPagination.isLoadingOlder,
    }),
    reconcileActiveConversation,
  });

}
