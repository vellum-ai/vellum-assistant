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
import { useTurnStore } from "@/domains/chat/turn-store";
import {
  canStopGeneration,
  isSendDisabled,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/chat/turn-selectors";
import { hasAnyInteractiveSurface, hasPendingAssistantResponse } from "@/domains/chat/utils/chat";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import { useActiveConversationIsProcessing } from "@/lib/backwards-compat/conversation-processing-state";
import { useConversationStore } from "@/stores/conversation-store";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface ChatUIState {
  uiContext: UIContext;
  /** Whether the turn phase is `"idle"` (no active turn in progress). */
  isIdle: boolean;
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
  /** Resolved active assistant ID (from resolved-assistants-store). */
  assistantId: string | null;
  /** Active conversation ID (from conversation-store). */
  activeConversationId: string | null;
  /** Active conversation data (TanStack Query — deduped). */
  activeConversation: Conversation | undefined;
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

  const phase = useTurnStore.use.phase();
  const activeToolCallCount = useTurnStore.use.activeToolCallCount();
  const statusText = useTurnStore.use.statusText();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();

  // TanStack Query — deduped with any other call for the same conversation.
  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);

  // --- Derived values (memoized) ------------------------------------------

  // Conversation processing. The daemon's `isProcessing` flag is the single
  // source of truth on 0.8.8+; older daemons fall back to the client
  // optimistic mirror. See `lib/backwards-compat/conversation-processing-state`.
  const activeConversationIsProcessing = useActiveConversationIsProcessing();

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

  // True once the live assistant row renders something visible — streamed
  // text, reasoning (the inline `SingleActivity` owns the loading state
  // then), a tool-call chip, or a surface. The standalone thinking-dots row
  // yields to this, and ONLY this: a live bubble with no renderable content
  // must keep the dots up, or the transcript reads as stalled (see
  // `shouldShowThinkingIndicator`).
  const hasVisibleResponseContent = useMemo(() => {
    if (liveAssistantMessageId == null) return false;
    const live = messages.find((m) => m.id === liveAssistantMessageId);
    if (!live) return false;
    return (
      (live.textSegments?.some((s) => s.trim().length > 0) ?? false) ||
      (live.thinkingSegments?.length ?? 0) > 0 ||
      (live.toolCalls?.length ?? 0) > 0 ||
      (live.surfaces?.length ?? 0) > 0 ||
      !!live.contentBlocks?.some(
        (b) =>
          b.type === "thinking" ||
          b.type === "tool_use" ||
          (b.type === "text" && b.text.trim().length > 0),
      )
    );
  }, [messages, liveAssistantMessageId]);

  const hasUncompletedVisibleSurface = useMemo(
    () => hasAnyInteractiveSurface(messages),
    [messages],
  );

  const uiContext: UIContext = useMemo(
    () => ({
      hasStreamingAssistantMessage,
      hasVisibleResponseContent,
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
      hasVisibleResponseContent,
      pendingSecret,
      pendingConfirmation,
      pendingQuestion,
      pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing,
      activeConversationHasPendingAssistantResponse,
    ],
  );

  const showThinking = shouldShowThinkingIndicator(phase, activeToolCallCount, uiContext);
  const isAssistantStreaming = showThinking || hasStreamingAssistantMessage;
  const canStopGenerating = canStopGeneration(phase, uiContext);
  const isSendDisabledFromTurn = isSendDisabled(uiContext);
  const thinkingLabel = statusText;

  return {
    uiContext,
    isIdle: phase === "idle",
    showThinking,
    isAssistantStreaming,
    canStopGenerating,
    isSendDisabledFromTurn,
    thinkingLabel,
    liveAssistantMessageId,
    activeConversationIsProcessing,
    assistantId,
    activeConversationId,
    activeConversation,
  };
}
