/**
 * Conversation history lifecycle — TanStack Query data sync.
 *
 * Bridges `useHistoryPagination` (TanStack Query infinite query) and the
 * `useChatSessionStore` (Zustand):
 *
 * - When TQ delivers data (from cache or network), applies it to the shared
 *   `messages` state, reconstructs subagent state, restores pending
 *   interactions, refreshes surface content, and detects auto-greet.
 *
 * - Conversation-switch resets are handled by the store's
 *   `switchToConversation()` action — this hook only consumes the
 *   `switchResetPending` / `lastAppliedDataTimestamp` coordination fields
 *   set by that action.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries}
 */

import { captureError } from "@/lib/sentry/capture-error";
import { startTransition, useEffect } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { reconcileLatestHistorySnapshot } from "@/domains/chat/utils/reconcile-snapshot";
import { extractWirePendingConfirmation } from "@/domains/chat/utils/chat";
import { filterDismissedSurfaces } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { recordDiagnostic } from "@/lib/diagnostics";
import { recordServerSeq } from "@/lib/streaming/server-seq";
import { getLocalSeq, recordLocalSeq } from "@/lib/streaming/local-seq";
import { anchorColdStartReplay } from "@/lib/streaming/cold-anchor";
import { summarizeDisplayMessages } from "@/domains/chat/utils/diagnostics";
import { useConversationStore } from "@/stores/conversation-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

import {
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/utils/send-message-utils";
import type { AssistantStateKind } from "@/domains/chat/types";
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
  // Store actions (stable references — safe in dependency arrays)
  // -------------------------------------------------------------------------
  const setMessages = useChatSessionStore.use.setMessages();
  const setTranscriptPagination = useChatSessionStore.use.setTranscriptPagination();
  const setIsLoadingHistory = useChatSessionStore.use.setIsLoadingHistory();
  const setError = useChatSessionStore.use.setError();

  // -------------------------------------------------------------------------
  // Conversation-switch reset — calls the store action when the active
  // conversation changes.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (assistantStateKind !== "active" || !assistantId || !activeConversationId) {
      return;
    }
    useChatSessionStore.getState().switchToConversation({
      assistantId,
      activeConversationId,
    });
  }, [assistantStateKind, assistantId, activeConversationId]);

  // -------------------------------------------------------------------------
  // Apply TanStack Query data to messages state
  // -------------------------------------------------------------------------
  useEffect(() => {
    const store = useChatSessionStore.getState();
    if (!pagination.isSuccess || pagination.dataUpdatedAt === store.lastAppliedDataTimestamp) {
      return;
    }
    if (!assistantId || !activeConversationId) return;

    useChatSessionStore.getState().setLastAppliedDataTimestamp(pagination.dataUpdatedAt);

    // Record the accepted snapshot's seq as the conversation baseline. This
    // is the point where TanStack Query's committed latest page is applied to
    // client state, so an out-of-order or aborted fetch (which never becomes
    // committed query data) can't regress the baseline. Older-page loads keep
    // the same `latestPage`, so re-running here records the same seq.
    const latestPageSeq = pagination.latestPage?.seq ?? null;
    // Capture the local seq `L` before advancing it so the merge below
    // can tell whether this page moved the frontier (`S > L`).
    const priorLocalSeq = getLocalSeq(activeConversationId);
    recordServerSeq(activeConversationId, latestPageSeq);
    recordLocalSeq(activeConversationId, latestPageSeq);
    // On a cold session, anchor the live SSE connection at this snapshot
    // watermark so the daemon ring-replays events emitted between the
    // snapshot and the stream attaching. No-op once the connection is warm
    // (cursor already seeded) or when the snapshot reports no seq.
    anchorColdStartReplay(latestPageSeq);

    const isFreshSwitch = store.switchResetPending;
    if (isFreshSwitch) {
      useChatSessionStore.getState().consumeSwitchReset();
    }

    recordDiagnostic("history_tq_data_apply", {
      assistantId,
      conversationId: activeConversationId,
      isFreshSwitch,
      pageCount: pagination.latestPage ? 1 : 0,
      messageCount: pagination.messages.length,
    });

    if (pagination.messages.length > 0) {
      const dismissedSurfaceIds = useChatSessionStore.getState().dismissedSurfaceIds;
      const filteredMessages = filterDismissedSurfaces(
        pagination.messages,
        dismissedSurfaceIds,
      );

      recordDiagnostic("history_tq_set_messages", {
        assistantId,
        conversationId: activeConversationId,
        isFreshSwitch,
        dismissedSurfaceCount: dismissedSurfaceIds.size,
        filteredMessages: summarizeDisplayMessages(filteredMessages),
      });

      startTransition(() => {
        setMessages((prev) => {
          const nextMessages =
            isFreshSwitch || prev.length === 0
              ? filteredMessages
              : reconcileLatestHistorySnapshot(prev, filteredMessages, {
                  serverSeq: latestPageSeq,
                  localSeq: priorLocalSeq,
                  oldestPageTimestamp: pagination.oldestLoadedTimestamp,
                });
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
      const requestedConversationForSurfaces = activeConversationId;
      for (const msg of filteredMessages) {
        if (!msg.surfaces) continue;
        for (const surface of msg.surfaces) {
          fetchSurfaceContent(assistantId, surface.surfaceId, activeConversationId).then(
            (fresh) => {
              if (!fresh) return;
              if (useChatSessionStore.getState().previousConversationId !== requestedConversationForSurfaces) return;
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
      // Restore an in-flight confirmation the snapshot carries on a tool call
      // (stamped by the daemon from the pending-interactions registry at render
      // time). On a cold reconnect the prompt rides the snapshot rather than a
      // replayed `confirmation_request` event, and binding it to its tool call
      // restores the inline card on the right chip. Skipped when a prompt is
      // already active so a live in-progress confirmation is never clobbered.
      const wirePendingConfirmation =
        extractWirePendingConfirmation(filteredMessages);
      if (
        wirePendingConfirmation &&
        !useInteractionStore.getState().pendingConfirmation
      ) {
        const interactionStore = useInteractionStore.getState();
        interactionStore.showConfirmation(wirePendingConfirmation);
        if (wirePendingConfirmation.toolUseId) {
          interactionStore.setInlineConfirmationToolCallId(
            wirePendingConfirmation.toolUseId,
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
    const requestedConversationId = activeConversationId;
    void (async () => {
      try {
        const interactions = await getPendingInteractions(
          assistantId,
          requestedConversationId,
        );
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
        if (
          interactions.pendingConfirmation &&
          !useInteractionStore.getState().pendingConfirmation
        ) {
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
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
  ]);

  // -------------------------------------------------------------------------
  // Refetch history when the SSE connection reopens after a disconnect.
  //
  // The daemon's replay ring only holds ~30s of events, so a connection
  // that reopens later than that (e.g. the device slept or the tab was
  // backgrounded — routine for this app) can't be ring-replayed. The
  // daemon then goes live silently and relies on the consumer's seq-gap
  // detector to notice and refetch, but that detector only fires on the
  // next conversation-scoped live event. An idle conversation receives
  // no such event, so the persisted tail emitted before the disconnect
  // stays invisible until the query remounts on a manual refresh.
  //
  // `refetchOnReconnect`/`refetchOnWindowFocus` are off (they key off the
  // browser's network/focus state, not this app's SSE reconnect), so the
  // reopen itself is the signal to refetch. Invalidating the query routes
  // the catch-up through the same fetch-and-merge path as the initial
  // load, which the monotonic seq merge makes a no-op when nothing new
  // landed. `"fresh"`/`"anchor"` reopens are skipped: the first connect's
  // `refetchOnMount` already loaded the snapshot, and the anchor bounce
  // fires immediately after that load with the ring still warm.
  // -------------------------------------------------------------------------
  useBusSubscription("sse.opened", ({ assistantId: openedAssistantId, cause }) => {
    if (cause === "fresh" || cause === "anchor") return;
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId ||
      openedAssistantId !== assistantId
    ) {
      return;
    }
    void pagination.invalidate();
  });

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

    const isOlderPageError = pagination.isSuccess;
    captureError(pagination.error, {
      context: isOlderPageError
        ? "conversation_history_older_page"
        : "conversation_history_initial",
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
