
import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  startTransition,
  useEffect,
  useRef,
} from "react";

import {
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
} from "@/domains/chat/utils/reconcile.js";
import {
  filterDismissedSurfaces,
  loadDismissedSurfaceIds,
} from "@/domains/chat/utils/dismissedSurfacesStorage.js";
import { fetchLatestHistoryPage } from "@/domains/chat/api/history.js";
import {
  recordChatDiagnostic,
  summarizeDisplayMessages,
} from "@/domains/chat/utils/diagnostics.js";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import { useTurnStore } from "@/domains/messaging/turn-store.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import type { SubagentStatus } from "@/domains/chat/api/event-types.js";

import type { RefreshSettleHandle } from "@/domains/chat/hooks/use-pull-refresh.js";
import {
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/hooks/use-send-message.js";
import type { AssistantStateKind, ChatError } from "@/domains/chat/types.js";
import { getPendingInteractions } from "@/domains/chat/api/interactions.js";
import { fetchSurfaceContent } from "@/domains/chat/api/surfaces.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CACHED_CONVERSATIONS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryPaginationSnapshot {
  hasMore: boolean;
  oldestTimestamp: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Merge a latest-history-page result's pagination with an optional base
 * (e.g. from the conversation cache).  The base wins when it covers older
 * messages than the latest page alone.
 */
export function getPaginationAfterLatestHistory(
  result: { hasMore: boolean; oldestTimestamp: number | null },
  basePagination?: HistoryPaginationSnapshot,
): HistoryPaginationSnapshot {
  const latestPagination: HistoryPaginationSnapshot = {
    hasMore: result.hasMore,
    oldestTimestamp: result.oldestTimestamp,
  };
  if (!basePagination || basePagination.oldestTimestamp == null) {
    return latestPagination;
  }
  if (
    latestPagination.oldestTimestamp == null ||
    basePagination.oldestTimestamp < latestPagination.oldestTimestamp
  ) {
    return basePagination;
  }
  return latestPagination;
}

interface UseConversationHistoryParams {
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationKey: string | null;
  refreshEpoch: number;
  transcriptPagination: Omit<TranscriptPaginationState, "items">;

  // Refs (owned by parent, read/written by this hook)
  conversationCacheRef: MutableRefObject<
    Map<string, { messages: DisplayMessage[]; pagination: HistoryPaginationSnapshot }>
  >;
  draftKeyResolutionRef: MutableRefObject<boolean>;
  previousConversationKeyRef: MutableRefObject<string | null>;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  draftsRef: MutableRefObject<Map<string, string>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;

  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  needsNewBubbleRef: MutableRefObject<boolean>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  refreshSettleRef: MutableRefObject<RefreshSettleHandle | null>;
  lastSuggestionMsgIdRef: MutableRefObject<string | null>;
  autoGreetRef: MutableRefObject<boolean>;
  initialPageOldestTsRef: MutableRefObject<number | null>;
  isLoadingOlderRef: MutableRefObject<boolean>;
  historyLoadedRef: MutableRefObject<boolean>;
  loadEpochRef: MutableRefObject<number>;

  // State setters
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;
  setIsLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setAutoGreetPending: Dispatch<SetStateAction<boolean>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
  setSuggestion: Dispatch<SetStateAction<string | null>>;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;
  setInput: Dispatch<SetStateAction<string>>;

  // Callbacks
  resetChatAttachments: () => void;
  syncNeedsNewBubbleFromMessages: (nextMessages: DisplayMessage[]) => void;

  /**
   * Fires after a non-empty saved draft is restored into the composer on a
   * genuine conversation switch. Receives the conversation key the draft
   * belongs to. Used by the page to render a transient "Draft restored"
   * notice so the user does not mistake the restored text for a stale
   * unsent message (see LUM-1516). Optional -- omit to suppress the notice
   * (e.g. in tests).
   */
  onDraftRestored?: (conversationKey: string) => void;

  // Error classification
  shouldSuppressGenericChatErrorNotice: (prev: ChatError | null) => boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages conversation history loading and caching when the active
 * conversation changes.
 *
 * Handles:
 * - Saving outgoing conversation drafts and messages to the LRU cache
 * - Resetting per-conversation state on switch
 * - Restoring cached messages or fetching fresh history from the server
 * - Reconciling cache with latest server data
 * - Restoring pending interactions (secrets, confirmations)
 * - Refreshing surface content for embedded surfaces
 * - Auto-greet detection for fresh conversations
 */
export function useConversationHistory({
  assistantId,
  assistantStateKind,
  activeConversationKey,
  refreshEpoch,
  transcriptPagination,
  conversationCacheRef,
  draftKeyResolutionRef,
  previousConversationKeyRef,
  inputRef,
  draftsRef,
  messagesRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  needsNewBubbleRef,
  streamingMessageIdsRef,
  pendingQueuedStableIdsRef,
  requestIdToStableIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  refreshSettleRef,
  lastSuggestionMsgIdRef,
  autoGreetRef,
  initialPageOldestTsRef,
  isLoadingOlderRef,
  historyLoadedRef,
  loadEpochRef,
  setMessages,
  setTranscriptPagination,
  setIsLoadingHistory,
  setError,
  setAutoGreetPending,
  setContextWindowUsage,
  setSuggestion,
  setCompactionCircuitOpenUntil,
  setInput,
  resetChatAttachments,
  syncNeedsNewBubbleFromMessages,
  onDraftRestored,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationHistoryParams) {
  const transcriptPaginationRef = useRef(transcriptPagination);
  useEffect(() => {
    transcriptPaginationRef.current = transcriptPagination;
  }, [transcriptPagination]);

  // -------------------------------------------------------------------------
  // Load message history when the active conversation changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (assistantStateKind !== "active" || !assistantId || !activeConversationKey) {
      return;
    }

    // Key resolution (draft->server ID), not a real switch -- skip reset.
    if (draftKeyResolutionRef.current) {
      draftKeyResolutionRef.current = false;
      return;
    }

    // Save the outgoing conversation's draft and messages so they can be
    // restored on switch-back without a server round-trip.
    const outgoingKey = previousConversationKeyRef.current;
    // Distinguish a real conversation switch (drives draft restoration UX)
    // from an effect re-run on the same conversation (e.g. pull-to-refresh
    // incrementing `refreshEpoch`, feature-flag deps changing). On a
    // same-key re-run the user's current input was just round-tripped
    // through `draftsRef` by the refresh handler and must not be surfaced
    // as a "restored draft" -- see comment on `onDraftRestored?.()` below.
    const isConversationSwitch = Boolean(
      outgoingKey && outgoingKey !== activeConversationKey,
    );
    if (isConversationSwitch && outgoingKey) {
      const currentInput = inputRef.current?.value ?? "";
      if (currentInput.trim()) {
        draftsRef.current.set(outgoingKey, currentInput);
      } else {
        draftsRef.current.delete(outgoingKey);
      }
      // If the outgoing conversation has a pending interaction, mark it as
      // needing attention so the sidebar shows an alert icon.
      const interactionSnapshot = useInteractionStore.getState();
      if (interactionSnapshot.pendingSecret || interactionSnapshot.pendingConfirmation) {
        useConversationStore.getState().addAttentionKey(outgoingKey);
      }
      // Cache outgoing conversation's messages (LRU eviction)
      const outgoingMessages = messagesRef.current;
      if (outgoingMessages.length > 0) {
        if (conversationCacheRef.current.size >= MAX_CACHED_CONVERSATIONS) {
          const firstKey = conversationCacheRef.current.keys().next().value;
          if (firstKey) conversationCacheRef.current.delete(firstKey);
        }
        const paginationSnapshot = transcriptPaginationRef.current;
        conversationCacheRef.current.set(outgoingKey, {
          messages: outgoingMessages,
          pagination: {
            hasMore: paginationSnapshot.hasMore,
            oldestTimestamp: paginationSnapshot.oldestTimestamp,
          },
        });
        recordChatDiagnostic("history_cache_save", {
          assistantId,
          conversationKey: outgoingKey,
          pagination: {
            hasMore: paginationSnapshot.hasMore,
            oldestTimestamp: paginationSnapshot.oldestTimestamp,
          },
          messages: summarizeDisplayMessages(outgoingMessages),
        });
      }
    }
    previousConversationKeyRef.current = activeConversationKey;

    // Restore the incoming conversation's draft (or clear the input).
    // Gate on a genuine conversation switch: same-key effect re-runs (e.g.
    // pull-to-refresh incrementing `refreshEpoch`, `conversationGroupsUI`
    // toggling) must not overwrite the user's in-progress composer input
    // with whatever stale value lives at this conversation's draft slot.
    // The user's current text IS the live state at that point and is
    // already preserved by `inputRef.current`.
    let savedDraft = "";
    if (isConversationSwitch) {
      savedDraft = draftsRef.current.get(activeConversationKey) ?? "";
      setInput(savedDraft);
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    }
    // Surface the restore to the page so it can render a transient notice.
    // Without this, the user can mistake the restored text for stale
    // content from a prior send (LUM-1516, part 2). Empty restores are
    // the expected default and not worth a notice.
    if (isConversationSwitch && savedDraft.length > 0) {
      onDraftRestored?.(activeConversationKey);
    }

    // Reset all per-conversation state so nothing leaks between threads.
    isLoadingOlderRef.current = false;
    initialPageOldestTsRef.current = null;
    historyLoadedRef.current = false;
    const epoch = ++loadEpochRef.current;
    const invalidatePendingConversationLoad = () => {
      ++loadEpochRef.current;
      setIsLoadingHistory(false);
    };
    recordChatDiagnostic("conversation_load_start", {
      assistantId,
      conversationKey: activeConversationKey,
      outgoingConversationKey: outgoingKey ?? null,
      epoch,
      previousMessages: summarizeDisplayMessages(messagesRef.current),
      previousPagination: transcriptPaginationRef.current,
      cacheSize: conversationCacheRef.current.size,
    });
    useTurnStore.getState().resetTurn();
    setIsLoadingHistory(true);
    needsNewBubbleRef.current = true;
    setMessages([]);
    streamingMessageIdsRef.current.clear();
    pendingQueuedStableIdsRef.current = [];
    requestIdToStableIdRef.current.clear();
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
      contextWindowUsageByConversationRef.current.get(activeConversationKey) ?? null,
    );
    dismissedSurfaceIdsRef.current = loadDismissedSurfaceIds(
      assistantId,
      activeConversationKey,
    );
    setError((prev) =>
      shouldSuppressGenericChatErrorNotice(prev) ? prev : null,
    );

    // --- Inner helpers (scoped to this effect's epoch) ---------------------

    const refreshSurfaceContentForMessages = (messagesToRefresh: DisplayMessage[]) => {
      for (const msg of messagesToRefresh) {
        if (!msg.surfaces) continue;
        for (const surface of msg.surfaces) {
          fetchSurfaceContent(assistantId, surface.surfaceId, activeConversationKey).then((fresh) => {
            if (!fresh || loadEpochRef.current !== epoch) return;
            setMessages((prev) => {
              if (loadEpochRef.current !== epoch) return prev;
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i]!;
                const idx = m.surfaces?.findIndex((s) => s.surfaceId === fresh.surfaceId) ?? -1;
                if (idx === -1) continue;
                const updated = [...prev];
                const newSurfaces = [...m.surfaces!];
                newSurfaces[idx] = { ...newSurfaces[idx]!, data: fresh.data, title: fresh.title ?? newSurfaces[idx]!.title };
                updated[i] = { ...m, surfaces: newSurfaces };
                return updated;
              }
              return prev;
            });
          });
        }
      }
    };

    const restorePendingInteractions = async () => {
      try {
        const interactions = await getPendingInteractions(assistantId, activeConversationKey);
        if (loadEpochRef.current !== epoch) return;
        if (interactions.pendingSecret) {
          const parsed = parsePendingSecretState(
            interactions.pendingSecret as Record<string, unknown>,
          );
          if (loadEpochRef.current === epoch) {
            useInteractionStore.getState().showSecret(parsed);
          }
        }
        if (interactions.pendingConfirmation) {
          const { state } = parsePendingConfirmationData(
            interactions.pendingConfirmation as Record<string, unknown>,
          );
          if (loadEpochRef.current === epoch) {
            useInteractionStore.getState().showConfirmation(state);
          }
        }
        if (!interactions.pendingSecret && !interactions.pendingConfirmation) {
          useConversationStore.getState().removeAttentionKey(activeConversationKey);
        }
      } catch {
        // Keep attention key on failure -- the prompt wasn't restored.
      }
    };

    type LatestHistoryPage = Awaited<ReturnType<typeof fetchLatestHistoryPage>>;

    const applyLatestHistoryResult = async (
      result: LatestHistoryPage,
      options: {
        basePagination?: HistoryPaginationSnapshot;
        mergeWithCurrent?: boolean;
        source?: string;
      } = {},
    ) => {
      if (loadEpochRef.current !== epoch) return;
      const nextPagination = getPaginationAfterLatestHistory(
        result,
        options.basePagination,
      );
      historyLoadedRef.current = true;
      initialPageOldestTsRef.current = nextPagination.oldestTimestamp;
      recordChatDiagnostic("history_latest_apply", {
        assistantId,
        conversationKey: activeConversationKey,
        epoch,
        source: options.source,
        basePagination: options.basePagination,
        hasMore: result.hasMore,
        oldestTimestamp: result.oldestTimestamp,
        oldestMessageId: result.oldestMessageId,
        nextPagination,
        messages: summarizeDisplayMessages(result.messages),
      });
      if (result.messages.length > 0) {
        const filteredMessages = filterDismissedSurfaces(
          result.messages,
          dismissedSurfaceIdsRef.current,
        );
        recordChatDiagnostic("history_latest_set_messages", {
          assistantId,
          conversationKey: activeConversationKey,
          epoch,
          source: options.source,
          dismissedSurfaceCount: dismissedSurfaceIdsRef.current.size,
          filteredMessages: summarizeDisplayMessages(filteredMessages),
        });
        startTransition(() => {
          setMessages((prev) => {
            if (loadEpochRef.current !== epoch) return prev;
            const nextMessages = options.mergeWithCurrent
              ? reconcileDisplayMessagesWithLatestHistory(prev, filteredMessages)
              : filteredMessages;
            syncNeedsNewBubbleFromMessages(nextMessages);
            return nextMessages;
          });
          setTranscriptPagination((prev) =>
            loadEpochRef.current === epoch
              ? {
                  hasMore: nextPagination.hasMore,
                  oldestTimestamp: nextPagination.oldestTimestamp,
                  isLoadingOlder: false,
                  isPinnedToLatest: true,
                }
              : prev,
          );
          setIsLoadingHistory((prev) =>
            loadEpochRef.current === epoch ? false : prev,
          );
        });
        refreshSurfaceContentForMessages(filteredMessages);
      } else {
        recordChatDiagnostic("history_latest_empty", {
          assistantId,
          conversationKey: activeConversationKey,
          epoch,
          source: options.source,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp,
        });
        setIsLoadingHistory(false);
      }

      // Reconstruct subagent state from history notifications.
      // History may contain multiple notifications for the same subagent
      // (e.g. a "running" notification followed by a "completed" one).
      // Deduplicate by subagentId: keep status/error/conversationId from
      // the last notification (terminal state) but preserve
      // parentMessageId from the first (spawn-time position).
      if (result.subagentNotifications && result.subagentNotifications.length > 0) {
        const deduped = new Map<string, (typeof result.subagentNotifications)[number]>();
        for (const n of result.subagentNotifications) {
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

      await restorePendingInteractions();

      if (loadEpochRef.current !== epoch) {
        return;
      }

      // Auto-send greeting after fresh setup (API key just provisioned, no history)
      if (
        !options.mergeWithCurrent &&
        autoGreetRef.current &&
        result.messages.length === 0
      ) {
        setAutoGreetPending(true);
      }

      // Settle any in-flight pull-to-refresh for this conversation.
      const settle = refreshSettleRef.current;
      if (settle && settle.conversationKey === activeConversationKey) {
        refreshSettleRef.current = null;
        settle.resolve();
      }
    };

    const handleLatestHistoryError = (err: unknown, source?: string) => {
      if (loadEpochRef.current !== epoch) return;
      recordChatDiagnostic("history_latest_fetch_error", {
        assistantId,
        conversationKey: activeConversationKey,
        epoch,
        source,
        messageLength: err instanceof Error ? err.message.length : null,
      });
      Sentry.captureException(err, {
        tags: {
          context: source === "cache_restore_reconcile"
            ? "fetch_latest_history_page_after_cache_restore"
            : "fetch_latest_history_page",
        },
      });
      const settle = refreshSettleRef.current;
      if (settle && settle.conversationKey === activeConversationKey) {
        refreshSettleRef.current = null;
        settle.reject(err);
        if (!source) setIsLoadingHistory(false);
        return;
      }
      if (!source) {
        setIsLoadingHistory(false);
        setError({ message: "Failed to load conversation history. Please try again." });
      }
    };

    // --- Cache check then fetch --------------------------------------------

    const cachedEntry = conversationCacheRef.current.get(activeConversationKey);
    if (cachedEntry) {
      historyLoadedRef.current = true;
      initialPageOldestTsRef.current = cachedEntry.pagination.oldestTimestamp;
      recordChatDiagnostic("history_cache_restore", {
        assistantId,
        conversationKey: activeConversationKey,
        epoch,
        pagination: cachedEntry.pagination,
        messages: summarizeDisplayMessages(cachedEntry.messages),
      });
      startTransition(() => {
        setMessages((prev) => {
          if (loadEpochRef.current !== epoch) return prev;
          syncNeedsNewBubbleFromMessages(cachedEntry.messages);
          return cachedEntry.messages;
        });
        setTranscriptPagination((prev) =>
          loadEpochRef.current === epoch
            ? {
                hasMore: cachedEntry.pagination.hasMore,
                oldestTimestamp: cachedEntry.pagination.oldestTimestamp,
                isLoadingOlder: false,
                isPinnedToLatest: true,
              }
            : prev,
        );
        setIsLoadingHistory((prev) =>
          loadEpochRef.current === epoch ? false : prev,
        );
      });
      refreshSurfaceContentForMessages(cachedEntry.messages);
      fetchLatestHistoryPage(assistantId, activeConversationKey)
        .then((result) =>
          applyLatestHistoryResult(result, {
            basePagination: cachedEntry.pagination,
            mergeWithCurrent: true,
            source: "cache_restore_reconcile",
          }),
        )
        .catch((err) => handleLatestHistoryError(err, "cache_restore_reconcile"));
      return invalidatePendingConversationLoad;
    }

    fetchLatestHistoryPage(assistantId, activeConversationKey)
      .then((result) => applyLatestHistoryResult(result))
      .catch((err) => handleLatestHistoryError(err));

    return invalidatePendingConversationLoad;
  }, [
    assistantStateKind,
    assistantId,
    activeConversationKey,
    resetChatAttachments,
    refreshEpoch,
    syncNeedsNewBubbleFromMessages,
    // Refs (stable references, listed for completeness):
    conversationCacheRef,
    draftKeyResolutionRef,
    previousConversationKeyRef,
    inputRef,
    draftsRef,
    messagesRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    needsNewBubbleRef,
    streamingMessageIdsRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    lastSuggestionMsgIdRef,
    autoGreetRef,
    initialPageOldestTsRef,
    isLoadingOlderRef,
    historyLoadedRef,
    loadEpochRef,
    refreshSettleRef,
    // Setters (stable references):
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    setInput,
    onDraftRestored,
    shouldSuppressGenericChatErrorNotice,
  ]);
}
