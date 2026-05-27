/**
 * Conversation-switch lifecycle — reset all per-conversation state when the
 * user navigates to a different conversation.
 *
 * Owns the two refs (`switchResetRef`, `lastAppliedDataRef`) that mediate
 * between a switch happening and the downstream TanStack Query data-apply
 * step: the switch flips `switchResetRef` so the apply effect knows to
 * replace messages rather than reconcile, and resets
 * `lastAppliedDataRef` so the next TQ update is treated as the first one
 * for the new conversation.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";

import { useTurnStore } from "@/domains/messaging/turn-store";
import { useInteractionStore } from "@/domains/interactions/interaction-store";
import { useConversationStore } from "@/domains/conversations/conversation-store";
import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics";
import { loadDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type { AssistantStateKind, ChatError } from "@/domains/chat/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseConversationSwitchParams {
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationId: string | null;

  // Refs owned by the parent that the reset clears or refreshes.
  draftConversationIdResolutionRef: MutableRefObject<boolean>;
  previousConversationIdRef: MutableRefObject<string | null>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedMessageIdsRef: MutableRefObject<string[]>;
  requestIdToMessageIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  lastSuggestionMsgIdRef: MutableRefObject<string | null>;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;

  // Setters wired into the surrounding chat-page state.
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;
  setIsLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setAutoGreetPending: Dispatch<SetStateAction<boolean>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
  setSuggestion: Dispatch<SetStateAction<string | null>>;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  resetChatAttachments: () => void;
  shouldSuppressGenericChatErrorNotice: (prev: ChatError | null) => boolean;
}

export interface ConversationSwitchHandles {
  /** True when the most recent switch-reset has fired and the data-apply
   *  effect hasn't yet consumed it. Consumers should set this to `false`
   *  after using it so subsequent background refetches reconcile instead
   *  of replace. */
  switchResetRef: MutableRefObject<boolean>;
  /** Timestamp (matching TanStack Query's `dataUpdatedAt`) of the last
   *  history payload the consumer applied. Reset to `0` on every switch
   *  so the next payload always triggers an apply for the new
   *  conversation. */
  lastAppliedDataRef: MutableRefObject<number>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationSwitch({
  assistantId,
  assistantStateKind,
  activeConversationId,
  draftConversationIdResolutionRef,
  previousConversationIdRef,
  streamingMessageIdsRef,
  pendingQueuedMessageIdsRef,
  requestIdToMessageIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  lastSuggestionMsgIdRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  setMessages,
  setTranscriptPagination,
  setIsLoadingHistory,
  setError,
  setAutoGreetPending,
  setContextWindowUsage,
  setSuggestion,
  setCompactionCircuitOpenUntil,
  resetChatAttachments,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationSwitchParams): ConversationSwitchHandles {
  const switchResetRef = useRef(false);
  const lastAppliedDataRef = useRef(0);

  useEffect(() => {
    if (assistantStateKind !== "active" || !assistantId || !activeConversationId) {
      return;
    }

    // Draft-key resolution (draft→server ID) is not a real switch.
    if (draftConversationIdResolutionRef.current) {
      draftConversationIdResolutionRef.current = false;
      return;
    }

    // Track outgoing conversation's attention state.
    const outgoingConversationId = previousConversationIdRef.current;
    const isConversationSwitch = Boolean(
      outgoingConversationId && outgoingConversationId !== activeConversationId,
    );
    if (isConversationSwitch && outgoingConversationId) {
      const interactionSnapshot = useInteractionStore.getState();
      if (interactionSnapshot.pendingSecret || interactionSnapshot.pendingConfirmation) {
        useConversationStore.getState().addAttentionConversationId(outgoingConversationId);
      }
    }
    previousConversationIdRef.current = activeConversationId;

    recordChatDiagnostic("conversation_switch_reset", {
      assistantId,
      conversationId: activeConversationId,
      outgoingConversationId: outgoingConversationId ?? null,
    });

    // Reset all per-conversation state so nothing leaks between threads.
    useTurnStore.getState().resetTurn();
    setIsLoadingHistory(true);
    setMessages([]);
    streamingMessageIdsRef.current.clear();
    pendingQueuedMessageIdsRef.current = [];
    requestIdToMessageIdRef.current.clear();
    pendingLocalDeletionsRef.current.clear();
    setTranscriptPagination({
      hasMore: false,
      oldestTimestamp: null,
      isLoadingOlder: false,
      isPinnedToLatest: true,
    });
    useInteractionStore.getState().resetAll();
    confirmationToolCallMapRef.current.clear();
    setAutoGreetPending(false);
    resetChatAttachments();
    setSuggestion(null);
    setCompactionCircuitOpenUntil(null);
    lastSuggestionMsgIdRef.current = null;
    setContextWindowUsage(
      contextWindowUsageByConversationRef.current.get(activeConversationId) ?? null,
    );
    dismissedSurfaceIdsRef.current = loadDismissedSurfaceIds(
      assistantId,
      activeConversationId,
    );
    setError((prev) =>
      shouldSuppressGenericChatErrorNotice(prev) ? prev : null,
    );

    // Signal that we're in a fresh-switch state — the data-apply effect
    // should replace messages rather than reconcile.
    switchResetRef.current = true;
    lastAppliedDataRef.current = 0;
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    resetChatAttachments,
    // Refs (stable references, listed for completeness):
    draftConversationIdResolutionRef,
    previousConversationIdRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    streamingMessageIdsRef,
    pendingQueuedMessageIdsRef,
    requestIdToMessageIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    lastSuggestionMsgIdRef,
    // Setters (stable references):
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    shouldSuppressGenericChatErrorNotice,
  ]);

  return { switchResetRef, lastAppliedDataRef };
}
