/**
 * Derived UI state for the active chat conversation.
 *
 * Reads turn, interaction, conversation, and message state from their
 * respective Zustand stores and computes the `UIContext` object plus the
 * boolean flags the component tree needs for render decisions (thinking
 * indicator, send-disabled, stop-generation button, streaming badge).
 *
 * @see {@link UIContext} for the shape of the derived context.
 * @see turn-selectors.ts for the pure selector functions.
 */

import { useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { type TurnState, useTurnStore } from "@/domains/chat/turn-store";
import {
  canStopGeneration,
  getThinkingStatusText,
  isSendDisabled,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/chat/turn-selectors";
import { hasAnyInteractiveSurface, hasPendingAssistantResponse } from "@/domains/chat/utils/chat";
import { liveAssistantRowId } from "@/domains/chat/hooks/stream-message-updaters";
import { useConversationStore } from "@/stores/conversation-store";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAssistantSelectionStore } from "@/assistant/selection-store";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface ChatUIState {
  uiContext: UIContext;
  showThinking: boolean;
  isAssistantStreaming: boolean;
  canStopGenerating: boolean;
  /** Whether the turn-level state blocks sending (pending secret or
   *  confirmation). Does NOT include typing-disabled conditions (loading
   *  history, maintenance, disk pressure, channel readonly) — the caller
   *  must OR those in separately. */
  isSendDisabledFromTurn: boolean;
  thinkingLabel: string | null;
  liveAssistantMessageId: string | null;
  activeConversationIsProcessing: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatUIState(): ChatUIState {
  // --- Store reads (atomic selectors → minimal re-renders) ----------------
  const messages = useChatSessionStore.use.messages();

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();
  const pendingQuestion = useInteractionStore.use.pendingQuestion();

  // The selector functions (shouldShowThinkingIndicator, canStopGeneration,
  // isSendDisabled, getThinkingStatusText) only access `phase`,
  // `activeToolCallCount`, and `statusText` from TurnState. Subscribe only
  // to those three; remaining TurnState fields are filled from the store
  // snapshot to satisfy the type without creating extra subscriptions.
  const phase = useTurnStore.use.phase();
  const activeToolCallCount = useTurnStore.use.activeToolCallCount();
  const statusText = useTurnStore.use.statusText();

  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();

  // TanStack Query — deduped with any other call for the same conversation.
  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);

  // --- Derived values (memoized) ------------------------------------------

  const turnState: TurnState = {
    ...useTurnStore.getState(),
    phase,
    activeToolCallCount,
    statusText,
  };

  // Conversation processing — OR of local optimistic set and server snapshot.
  const activeConversationIsProcessing =
    (activeConversationId != null &&
      processingConversationIds.has(activeConversationId)) ||
    !!activeConversation?.isProcessing;

  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  // `liveAssistantRowId` operates on raw (unsanitized) messages. This is
  // correct: sanitisation only removes blank user rows and sorts — it never
  // touches the tail assistant message that determines liveness.
  const liveAssistantMessageId = useMemo(
    () => liveAssistantRowId(messages, activeConversationIsProcessing),
    [messages, activeConversationIsProcessing],
  );
  const hasStreamingAssistantMessage = liveAssistantMessageId != null;

  const hasUncompletedVisibleSurface = useMemo(
    () => hasAnyInteractiveSurface(messages),
    [messages],
  );

  const uiContext: UIContext = useMemo(
    () => ({
      hasStreamingAssistantMessage,
      hasPendingSecret: !!pendingSecret,
      hasPendingConfirmation: !!pendingConfirmation,
      hasPendingQuestion: !!pendingQuestion,
      hasPendingContactRequest: !!pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing,
      hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
    }),
    [
      hasStreamingAssistantMessage,
      pendingSecret,
      pendingConfirmation,
      pendingQuestion,
      pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing,
      activeConversationHasPendingAssistantResponse,
    ],
  );

  const showThinking = shouldShowThinkingIndicator(turnState, uiContext);
  const isAssistantStreaming = showThinking || hasStreamingAssistantMessage;
  const canStopGenerating = canStopGeneration(turnState, uiContext);
  const isSendDisabledFromTurn = isSendDisabled(turnState, uiContext);
  const thinkingLabel = getThinkingStatusText(turnState);

  return {
    uiContext,
    showThinking,
    isAssistantStreaming,
    canStopGenerating,
    isSendDisabledFromTurn,
    thinkingLabel,
    liveAssistantMessageId,
    activeConversationIsProcessing,
  };
}
