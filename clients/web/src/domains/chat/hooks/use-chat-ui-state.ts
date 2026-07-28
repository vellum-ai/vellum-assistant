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
  isActiveTurnLive,
  isAssistantBusy as isAssistantBusySelector,
  isSendDisabled,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/chat/turn-selectors";
import { hasAnyInteractiveSurface } from "@/domains/chat/utils/chat";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import { useActiveConversationIsProcessing } from "@/lib/backwards-compat/conversation-processing-state";
import { isStreamAheadOfServerSnapshot } from "@/lib/streaming/server-seq";
import { useConversationStore } from "@/stores/conversation-store";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
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
  /** Whether the assistant is actively working (not waiting for user input).
   *  Single source of truth for the avatar spinner and stop button. */
  isAssistantBusy: boolean;
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
  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();
  const pendingQuestion = useInteractionStore.use.pendingQuestion();

  const phase = useTurnStore.use.phase();
  const activeToolCallCount = useTurnStore.use.activeToolCallCount();
  const statusText = useTurnStore.use.statusText();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();

  // All message-derived checks read the rendered transcript (the materialized
  // snapshot ⊕ optimistic sends) — the streaming assistant row is its tail
  // while a turn is in flight.
  const transcript = useTranscriptMessages();

  // Authoritative processing flag off the rolling snapshot; narrow selector so it re-renders only when the flag flips.
  const snapshotProcessing = useChatSessionStore((s) => s.snapshot?.processing);
  // The snapshot's fold frontier. Read reactively so this hook re-renders when a
  // stream fold or a `/messages` reseed moves the local/server watermarks — the
  // inputs to `streamAheadOfServer` below.
  const snapshotSeq = useChatSessionStore((s) => s.snapshot?.seq);

  // TanStack Query — deduped with any other call for the same conversation.
  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);

  // --- Derived values (memoized) ------------------------------------------

  // Legacy (pre-0.8.8) conversation-processing signal — consulted by
  // `isActiveTurnLive` only when the daemon omits the seq-folded snapshot flag.
  const conversationRowIsProcessing = useActiveConversationIsProcessing();

  // Whether the live stream has run past the durable `/messages` snapshot
  // (`L > S`). This is the seq arbiter for the turn CLOSE: while true, a
  // snapshot `processing: false` predates the live turn and must not settle it.
  // Computed inline (two map lookups) rather than memoized: the seq watermarks
  // are non-reactive module state, so recomputing every render — which the
  // reactive `snapshotSeq` read guarantees happens on every fold/reseed — is
  // both cheaper and staleness-free.
  void snapshotSeq;
  const streamAheadOfServer =
    activeConversationId != null &&
    isStreamAheadOfServerSnapshot(activeConversationId);

  // The single liveness source: server owns the close (seq-arbitrated), the
  // optimistic `phase` owns the open. Everything downstream — the avatar/stop
  // selector, the thinking dots, `liveAssistantRowId`, and the returned
  // `activeConversationIsProcessing` — derives from this one value.
  const activeConversationIsProcessing = isActiveTurnLive(phase, {
    snapshotProcessing,
    streamAheadOfServer,
    activeConversationIsProcessing: conversationRowIsProcessing,
  });

  // `liveAssistantRowId` operates on raw (unsanitized) messages. This is
  // correct: sanitisation only removes blank user rows and sorts — it never
  // touches the tail assistant message that determines liveness.
  const liveAssistantMessageId = useMemo(
    () => liveAssistantRowId(transcript, activeConversationIsProcessing),
    [transcript, activeConversationIsProcessing],
  );
  const hasStreamingAssistantMessage = liveAssistantMessageId != null;

  // True once the live assistant message has emitted reasoning content — at
  // which point an inline `SingleActivity` is rendering it (and owning the
  // streaming "Thinking" loading state). Used to hand off from the standalone
  // thinking-dots row so the two indicators never compete.
  const hasStreamingAssistantThinking = useMemo(() => {
    if (liveAssistantMessageId == null) return false;
    const live = transcript.find((m) => m.id === liveAssistantMessageId);
    if (!live) return false;
    return (
      (live.thinkingSegments?.length ?? 0) > 0 ||
      !!live.contentBlocks?.some((b) => b.type === "thinking")
    );
  }, [transcript, liveAssistantMessageId]);

  const hasUncompletedVisibleSurface = useMemo(
    () => hasAnyInteractiveSurface(transcript),
    [transcript],
  );

  const uiContext: UIContext = useMemo(
    () => ({
      hasStreamingAssistantMessage,
      hasStreamingAssistantThinking,
      hasPendingSecret: !!pendingSecret,
      hasPendingConfirmation: !!pendingConfirmation,
      hasPendingQuestion: !!pendingQuestion,
      hasPendingContactRequest: !!pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing: conversationRowIsProcessing,
      snapshotProcessing,
      streamAheadOfServer,
    }),
    [
      hasStreamingAssistantMessage,
      hasStreamingAssistantThinking,
      pendingSecret,
      pendingConfirmation,
      pendingQuestion,
      pendingContactRequest,
      hasUncompletedVisibleSurface,
      conversationRowIsProcessing,
      snapshotProcessing,
      streamAheadOfServer,
    ],
  );

  const showThinking = shouldShowThinkingIndicator(phase, activeToolCallCount, uiContext);
  const isAssistantBusy = isAssistantBusySelector(phase, uiContext);
  const isSendDisabledFromTurn = isSendDisabled(uiContext);
  const thinkingLabel = statusText;

  return {
    uiContext,
    isIdle: phase === "idle",
    showThinking,
    isAssistantBusy,
    isSendDisabledFromTurn,
    thinkingLabel,
    liveAssistantMessageId,
    activeConversationIsProcessing,
    assistantId,
    activeConversationId,
    activeConversation,
  };
}
