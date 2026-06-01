/**
 * Conversation history lifecycle — switch resets + TanStack Query data sync.
 *
 * This hook handles two concerns:
 *
 * 1. **Conversation-switch resets** — when `activeConversationId` changes,
 *    reset all per-conversation state (turn, interactions, subagents,
 *    pending messages, dismissed surfaces, etc.) so nothing leaks between
 *    conversations.
 *
 * 2. **History data sync** — when `useHistoryPagination` (TanStack Query)
 *    delivers data (from cache or network), apply it to the shared
 *    `messages` state, reconstruct subagent state, restore pending
 *    interactions, refresh surface content, and detect auto-greet.
 *
 * The fetch/cache/cancellation machinery that previously lived here
 * (`conversationCacheRef`, `loadEpochRef`, manual LRU rotation) has been
 * replaced by `useHistoryPagination` — a thin `useInfiniteQuery` wrapper
 * that handles all of that via TanStack Query's built-in mechanisms.
 */

import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  startTransition,
  useEffect,
} from "react";

import {
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
} from "@/domains/chat/utils/reconcile";
import { filterDismissedSurfaces } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { recordDiagnostic } from "@/lib/diagnostics";
import { summarizeDisplayMessages } from "@/domains/chat/utils/diagnostics";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import { useConversationStore } from "@/stores/conversation-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

import {
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/hooks/use-send-message";
import { useConversationSwitch } from "@/domains/chat/hooks/use-conversation-switch";
import type { AssistantStateKind, ChatError } from "@/domains/chat/types";
import { getPendingInteractions } from "@/domains/chat/api/interactions";
import { fetchSurfaceContent } from "@/domains/chat/api/surfaces";
import {
  useHistoryPagination,
  type HistoryPaginationResult,
} from "@/domains/chat/transcript/use-history-pagination";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseConversationHistoryParams {
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationId: string | null;

  // Refs (owned by parent, read/written by this hook)
  draftConversationIdResolutionRef: MutableRefObject<boolean>;
  previousConversationIdRef: MutableRefObject<string | null>;

  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedMessageIdsRef: MutableRefObject<string[]>;
  requestIdToMessageIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  autoGreetRef: MutableRefObject<boolean>;

  // State setters
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;
  setIsLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setAutoGreetPending: Dispatch<SetStateAction<boolean>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // Callbacks
  resetChatAttachments: () => void;

  // Error classification
  shouldSuppressGenericChatErrorNotice: (prev: ChatError | null) => boolean;
}

export interface ConversationHistoryResult {
  pagination: HistoryPaginationResult;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationHistory({
  assistantId,
  assistantStateKind,
  activeConversationId,
  draftConversationIdResolutionRef,
  previousConversationIdRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  streamingMessageIdsRef,
  pendingQueuedMessageIdsRef,
  requestIdToMessageIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  autoGreetRef,
  setMessages,
  setTranscriptPagination,
  setIsLoadingHistory,
  setError,
  setAutoGreetPending,
  setContextWindowUsage,
  setCompactionCircuitOpenUntil,
  resetChatAttachments,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationHistoryParams): ConversationHistoryResult {
  // -------------------------------------------------------------------------
  // TanStack Query for history fetching + caching + pagination
  // -------------------------------------------------------------------------
  const pagination = useHistoryPagination({
    assistantId,
    conversationId: activeConversationId,
    enabled: assistantStateKind === "active" && !!assistantId && !!activeConversationId,
  });

  // -------------------------------------------------------------------------
  // Conversation-switch reset — delegated to a focused hook. Owns the two
  // refs (`switchResetRef`, `lastAppliedDataRef`) the data-apply effect
  // below reads to decide between a fresh-switch replace and a
  // background-refetch reconcile.
  // -------------------------------------------------------------------------
  const { switchResetRef, lastAppliedDataRef } = useConversationSwitch({
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
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setCompactionCircuitOpenUntil,
    resetChatAttachments,
    shouldSuppressGenericChatErrorNotice,
  });

  // -------------------------------------------------------------------------
  // Apply TanStack Query data to messages state
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!pagination.isSuccess || pagination.dataUpdatedAt === lastAppliedDataRef.current) {
      return;
    }
    if (!assistantId || !activeConversationId) return;

    lastAppliedDataRef.current = pagination.dataUpdatedAt;
    const isFreshSwitch = switchResetRef.current;
    switchResetRef.current = false;

    recordDiagnostic("history_tq_data_apply", {
      assistantId,
      conversationId: activeConversationId,
      isFreshSwitch,
      pageCount: pagination.latestPage ? 1 : 0,
      messageCount: pagination.messages.length,
    });

    if (pagination.messages.length > 0) {
      const filteredMessages = filterDismissedSurfaces(
        pagination.messages,
        dismissedSurfaceIdsRef.current,
      );

      recordDiagnostic("history_tq_set_messages", {
        assistantId,
        conversationId: activeConversationId,
        isFreshSwitch,
        dismissedSurfaceCount: dismissedSurfaceIdsRef.current.size,
        filteredMessages: summarizeDisplayMessages(filteredMessages),
      });

      startTransition(() => {
        setMessages((prev) => {
          // Fresh switch or empty state: replace entirely with TQ data.
          // Background refetch while streaming: reconcile to preserve
          // optimistic/streaming messages.
          const nextMessages =
            isFreshSwitch || prev.length === 0
              ? filteredMessages
              : reconcileDisplayMessagesWithLatestHistory(
                  prev,
                  filteredMessages,
                  useConversationStore
                    .getState()
                    .processingConversationIds.has(activeConversationId),
                );
          return nextMessages;
        });
        setTranscriptPagination({
          hasMore: pagination.hasMore,
          oldestTimestamp: pagination.oldestLoadedTimestamp,
          isLoadingOlder: pagination.isFetchingOlderPages,
          isPinnedToLatest: true,
        });
        setIsLoadingHistory(false);
      });

      // Refresh surface content for embedded surfaces.
      for (const msg of filteredMessages) {
        if (!msg.surfaces) continue;
        for (const surface of msg.surfaces) {
          fetchSurfaceContent(assistantId, surface.surfaceId, activeConversationId).then(
            (fresh) => {
              if (!fresh) return;
              setMessages((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i]!;
                  const idx =
                    m.surfaces?.findIndex(
                      (s) => s.surfaceId === fresh.surfaceId,
                    ) ?? -1;
                  if (idx === -1) continue;
                  const updated = [...prev];
                  const newSurfaces = [...m.surfaces!];
                  newSurfaces[idx] = {
                    ...newSurfaces[idx]!,
                    data: fresh.data,
                    title: fresh.title ?? newSurfaces[idx]!.title,
                  };
                  updated[i] = { ...m, surfaces: newSurfaces };
                  return updated;
                }
                return prev;
              });
            },
          );
        }
      }
    } else {
      recordDiagnostic("history_tq_empty", {
        assistantId,
        conversationId: activeConversationId,
      });
      setIsLoadingHistory(false);
    }

    // Reconstruct subagent state from history notifications.
    const notifications = pagination.latestPage?.subagentNotifications;
    if (notifications && notifications.length > 0) {
      const deduped = new Map<
        string,
        (typeof notifications)[number]
      >();
      for (const n of notifications) {
        const existing = deduped.get(n.subagentId);
        if (existing) {
          deduped.set(n.subagentId, {
            ...n,
            parentMessageId: existing.parentMessageId,
          });
        } else {
          deduped.set(n.subagentId, n);
        }
      }

      const subagentStore = useSubagentStore.getState();
      subagentStore.reset();
      for (const n of deduped.values()) {
        subagentStore.spawnSubagent({
          subagentId: n.subagentId,
          label: n.label,
          objective: "",
          status: (n.status as SubagentStatus) || "completed",
          error: n.error,
          conversationId: n.conversationId,
          timestamp: Date.now(),
          parentMessageId: n.parentMessageId,
        });
      }
    }

    // Restore pending interactions (secrets, confirmations).
    // Capture the key before the await so we can detect stale responses
    // when the user switches conversations while the request is in flight.
    const requestedConversationId = activeConversationId;
    void (async () => {
      try {
        const interactions = await getPendingInteractions(
          assistantId,
          requestedConversationId,
        );
        // Guard: if the active conversation changed during the fetch,
        // discard the result to avoid leaking state across conversations.
        if (useConversationStore.getState().activeConversationId !== requestedConversationId) {
          return;
        }
        const parsed_secret = interactions.pendingSecret
          ? parsePendingSecretState(
              interactions.pendingSecret as Record<string, unknown>,
            )
          : null;
        if (parsed_secret) {
          useInteractionStore.getState().showSecret(parsed_secret);
        }
        if (interactions.pendingConfirmation) {
          const { state } = parsePendingConfirmationData(
            interactions.pendingConfirmation as Record<string, unknown>,
          );
          useInteractionStore.getState().showConfirmation(state);
        }
        if (!interactions.pendingSecret && !interactions.pendingConfirmation) {
          useConversationStore
            .getState()
            .removeAttentionConversationId(requestedConversationId);
        }
      } catch {
        // Keep attention key on failure.
      }
    })();

    // Auto-send greeting after fresh setup (no history).
    if (
      isFreshSwitch &&
      autoGreetRef.current &&
      pagination.messages.length === 0
    ) {
      setAutoGreetPending(true);
    }
  }, [
    pagination.isSuccess,
    pagination.dataUpdatedAt,
    pagination.messages,
    pagination.latestPage,
    pagination.hasMore,
    pagination.oldestLoadedTimestamp,
    pagination.isFetchingOlderPages,
    assistantId,
    activeConversationId,
    dismissedSurfaceIdsRef,
    autoGreetRef,
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setAutoGreetPending,
    setError,
  ]);

  // -------------------------------------------------------------------------
  // Sync older-page loading state (both true → false transitions)
  // -------------------------------------------------------------------------
  useEffect(() => {
    setTranscriptPagination((prev) => {
      if (prev.isLoadingOlder === pagination.isFetchingOlderPages) return prev;
      return { ...prev, isLoadingOlder: pagination.isFetchingOlderPages };
    });
  }, [pagination.isFetchingOlderPages, setTranscriptPagination]);

  // -------------------------------------------------------------------------
  // Handle TanStack Query errors
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!pagination.isError || !pagination.error) return;

    // Older-page failures are reported to Sentry but don't show a
    // user-facing error — the initial page loaded successfully and the
    // user can retry by scrolling up again.
    const isOlderPageError = pagination.isSuccess;
    Sentry.captureException(pagination.error, {
      tags: {
        context: isOlderPageError
          ? "conversation_history_older_page"
          : "conversation_history_initial",
      },
    });

    if (!isOlderPageError) {
      setIsLoadingHistory(false);
      setError({
        message: "Failed to load conversation history. Please try again.",
      });
    }
  }, [pagination.isError, pagination.isSuccess, pagination.error, setIsLoadingHistory, setError]);

  return { pagination };
}
