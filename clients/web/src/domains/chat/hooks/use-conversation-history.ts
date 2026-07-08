/**
 * Conversation history lifecycle — TanStack Query side-effects.
 *
 * Runs `useHistoryPagination` (the infinite query that owns persisted history)
 * and reacts to two transitions. History is never copied into client state —
 * the transcript reads the query cache directly (`useTranscriptMessages`).
 *
 * - **A newly committed snapshot** (`dataUpdatedAt` advances): records the seq
 *   baseline + cold-start replay anchor for the live stream, reconstructs
 *   subagent state, restores any pending interaction the snapshot carries, and
 *   refreshes embedded surface content into the query cache.
 *
 * - **The turn returning to idle**: the finished turn is now persisted
 *   server-side, so invalidate history. The committed-snapshot effect then
 *   reseeds the materialized snapshot from the authoritative server copy,
 *   replacing the client-folded turn with canonical ids/ordering.
 *
 * Conversation-switch resets are owned by the store's `switchToConversation()`.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries}
 */

import { captureError } from "@/lib/sentry/capture-error";
import { useCallback, useEffect, useRef } from "react";

import { type InfiniteData, useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  extractWirePendingConfirmation,
  extractWirePendingQuestion,
} from "@/domains/chat/utils/chat";
import { mapMessageSurfaces } from "@/domains/chat/utils/map-message-surfaces";
import { recordDiagnostic } from "@/lib/diagnostics";
import { recordServerSeq } from "@/lib/streaming/server-seq";
import { recordLocalSeq } from "@/lib/streaming/local-seq";
import { anchorColdStartReplay } from "@/lib/streaming/cold-anchor";
import { useConversationStore } from "@/stores/conversation-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { reconcileSubagentStoreFromNotifications } from "@/domains/chat/hooks/reconcile-subagent-hydration";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";

import {
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/utils/send-message-utils";
import type { AssistantStateKind } from "@/domains/chat/types";
import { getPendingInteractions } from "@/domains/chat/api/interactions";
import { fetchSurfaceContent } from "@/domains/chat/api/surfaces";
import {
  conversationHistoryQueryKey,
  useHistoryPagination,
  type HistoryPaginationResult,
} from "@/domains/chat/transcript/use-history-pagination";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  registerHistoryCachePatcher,
  type MessagesUpdater,
} from "@/domains/chat/transcript/patch-transcript-messages";

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

type HistoryCache = InfiniteData<PaginatedHistoryResult>;

/**
 * Structural equality for surface `data` payloads. Both sides come from the
 * same daemon surface-content endpoint, so a stable JSON serialization compares
 * correctly here. Used to skip no-op surface-content cache writes that would
 * otherwise re-trigger the `dataUpdatedAt`-keyed snapshot effect and loop.
 */
function surfaceContentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationHistory({
  assistantId,
  assistantStateKind,
  activeConversationId,
}: UseConversationHistoryParams): ConversationHistoryResult {
  const queryClient = useQueryClient();

  const pagination = useHistoryPagination({
    assistantId,
    conversationId: activeConversationId,
    enabled: assistantStateKind === "active" && !!assistantId && !!activeConversationId,
  });

  const setIsLoadingHistory = useChatSessionStore.use.setIsLoadingHistory();
  const setTranscriptPagination = useChatSessionStore.use.setTranscriptPagination();
  const setError = useChatSessionStore.use.setError();

  // -------------------------------------------------------------------------
  // Conversation-switch reset — delegated to the store action.
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
  // Register the history-cache writer for `patchTranscriptMessages`, so
  // imperative actions (confirmation cleanup, surface completion) can reach a
  // row that has already been handed off to the history cache — not just the
  // live turn. The updater no-ops on pages that don't contain the row, so the
  // cache ref stays stable when the target is live-only.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || !activeConversationId) {
      registerHistoryCachePatcher(null);
      return;
    }
    const key = conversationHistoryQueryKey(assistantId, activeConversationId);
    registerHistoryCachePatcher((updater: MessagesUpdater) => {
      queryClient.setQueryData<HistoryCache>(key, (old) => {
        if (!old) return old;
        let changed = false;
        const pages = old.pages.map((page) => {
          const next = updater(page.messages);
          if (next === page.messages) return page;
          changed = true;
          return { ...page, messages: next };
        });
        // Return `undefined` (a setQueryData no-op) when no page changed —
        // a live-turn-only patch must not bump this query's dataUpdatedAt,
        // or it would needlessly re-trigger the dataUpdatedAt-keyed snapshot
        // effect (subagent rebuild + surface re-verify) on every patch.
        return changed ? { ...old, pages } : undefined;
      });
    });
    return () => registerHistoryCachePatcher(null);
  }, [assistantId, activeConversationId, queryClient]);

  // -------------------------------------------------------------------------
  // React to a newly committed snapshot. Keyed on `dataUpdatedAt` so it runs
  // once per committed query result. The transcript reads history from the
  // cache; this effect only fires the side effects that ride on a snapshot.
  // The reads of `pagination.*` below are all from the same committed result,
  // so they are consistent at this `dataUpdatedAt`.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!pagination.isSuccess || !assistantId || !activeConversationId) {
      return;
    }

    // Seq baseline (replay idempotency) + cold-start ring-replay anchor.
    const latestPageSeq = pagination.latestPage?.seq ?? null;
    recordServerSeq(activeConversationId, latestPageSeq);
    recordLocalSeq(activeConversationId, latestPageSeq);
    anchorColdStartReplay(latestPageSeq);

    // Seed (or reseed) the materialized snapshot from the committed history,
    // replaying any buffered events that raced the fetch. This is the single
    // source the transcript renders from (⊕ optimistic sends). See
    // `chat-session-store`.
    useChatSessionStore.getState().seedSnapshot(activeConversationId, {
      messages: pagination.messages,
      seq: latestPageSeq,
      hasMore: pagination.hasMore,
      oldestTimestamp: pagination.oldestLoadedTimestamp,
      oldestMessageId: pagination.latestPage?.oldestMessageId ?? null,
      // The daemon's authoritative per-conversation `processing` flag must
      // ride every (re)seed: the stream reducer can only advance a defined
      // flag (`nextProcessingState` pins `undefined` forever), and the
      // `snapshotProcessing === false` close-gate in
      // `shouldShowThinkingIndicator` / `isAssistantBusy` starves without it.
      processing: pagination.latestPage?.processing,
    });

    setIsLoadingHistory(false);
    setTranscriptPagination({
      hasMore: pagination.hasMore,
      oldestTimestamp: pagination.oldestLoadedTimestamp,
      isLoadingOlder: pagination.isFetchingOlderPages,
    });

    recordDiagnostic("history_tq_data_apply", {
      assistantId,
      conversationId: activeConversationId,
      messageCount: pagination.messages.length,
    });

    // Restore an in-flight confirmation the snapshot carries on a tool call (a
    // cold reconnect rides the snapshot rather than a replayed event). Skipped
    // when a prompt is already active so a live confirmation is never clobbered.
    const wirePendingConfirmation = extractWirePendingConfirmation(
      pagination.messages,
    );
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

    // Restore an in-flight ask_question prompt the snapshot carries (same cold
    // reconnect path). Skipped when a prompt is already active.
    const wirePendingQuestion = extractWirePendingQuestion(pagination.messages);
    if (wirePendingQuestion && !useInteractionStore.getState().pendingQuestion) {
      useInteractionStore.getState().showQuestion(wirePendingQuestion);
    }

    // Refresh embedded surface content into the history cache.
    const requestedConversationForSurfaces = activeConversationId;
    for (const msg of pagination.messages) {
      if (!msg.surfaces) continue;
      for (const surface of msg.surfaces) {
        fetchSurfaceContent(
          assistantId,
          surface.surfaceId,
          activeConversationId,
        ).then((fresh) => {
          if (!fresh) return;
          if (
            useConversationStore.getState().activeConversationId !==
            requestedConversationForSurfaces
          ) {
            return;
          }
          queryClient.setQueryData<HistoryCache>(
            conversationHistoryQueryKey(
              assistantId,
              requestedConversationForSurfaces,
            ),
            (old) => {
              if (!old) return old;
              // Only write when the fetched content actually differs from what
              // the cache already holds. `setQueryData` bumps the query's
              // `dataUpdatedAt` unconditionally (even for deep-equal data), and
              // the snapshot effect below is keyed on `dataUpdatedAt` — so
              // writing back unchanged content would re-trigger the effect,
              // re-fetch the surface, and loop. Returning `undefined` when
              // nothing changed makes `setQueryData` a no-op and breaks it.
              let changed = false;
              const pages = old.pages.map((page) => ({
                ...page,
                messages: page.messages.map((m) => {
                  if (
                    !m.surfaces?.some((s) => s.surfaceId === fresh.surfaceId)
                  ) {
                    return m;
                  }
                  return mapMessageSurfaces(m, (s) => {
                    if (s.surfaceId !== fresh.surfaceId) return s;
                    const nextTitle = fresh.title ?? s.title;
                    if (
                      surfaceContentEqual(s.data, fresh.data) &&
                      s.title === nextTitle
                    ) {
                      return s;
                    }
                    changed = true;
                    return { ...s, data: fresh.data, title: nextTitle };
                  });
                }),
              }));
              return changed ? { ...old, pages } : undefined;
            },
          );
        });
      }
    }

    // Reconstruct subagent state from notifications across all loaded pages —
    // not just the latest page, or a subagent whose notification is in an older
    // page (e.g. one aborted early) gets an avatar badge but no inline row.
    const notifications = pagination.subagentNotifications;
    if (notifications && notifications.length > 0) {
      const deduped = new Map<string, (typeof notifications)[number]>();
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

      reconcileSubagentStoreFromNotifications(
        useSubagentStore.getState(),
        deduped.values(),
        Date.now(),
      );
    }

    // Seed background-task cards from the durable history aggregate: the
    // daemon's in-memory completed ring doesn't survive a restart, so live
    // `/background-tools` rehydration alone can't rebuild a finished card.
    // `seedFromHistory` is a terminal-wins, idempotent merge (never clobbers a
    // live entry); retiring stays owned by `useBackgroundTaskRehydration`.
    const completions = pagination.backgroundToolCompletions;
    if (completions && completions.length > 0) {
      useBackgroundTaskStore.getState().seedFromHistory(completions);
    }

    // Restore pending interactions (secrets, confirmations).
    const requestedConversationId = activeConversationId;
    void (async () => {
      try {
        const interactions = await getPendingInteractions(
          assistantId,
          requestedConversationId,
        );
        if (
          useConversationStore.getState().activeConversationId !==
          requestedConversationId
        ) {
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
    // `pagination.*` other than `dataUpdatedAt` intentionally excluded: they all
    // update together on a committed result, and listing the volatile ones (e.g.
    // `isFetchingOlderPages`) would re-run these side effects on older-page loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.dataUpdatedAt, assistantId, activeConversationId]);

  // -------------------------------------------------------------------------
  // Turn-end reseed. When a turn finishes, the persisted copy is authoritative,
  // so invalidate history; the committed-snapshot effect above reseeds the
  // materialized snapshot from the server copy (replacing the client-folded
  // turn). The monotonic seq baseline makes the reseed a no-op when nothing new
  // landed, and the buffered event tail is replayed so anything that raced the
  // fetch isn't lost.
  // -------------------------------------------------------------------------
  const refetchHistoryOnTurnEnd = useCallback(() => {
    if (!assistantId || !activeConversationId) return;
    void pagination.invalidate();
  }, [assistantId, activeConversationId, pagination]);

  // A turn is in progress for the active conversation when either the local
  // turn store is sending (a `useSendMessage` turn this client started) or the
  // conversation is flagged processing. The processing flag also covers
  // passively-observed turns the local flow never initiated — external channels
  // (phone, Slack, Telegram) and other-client sends — where `turnPhase` stays
  // idle. Refetch on the combined falling edge; for local sends both signals
  // clear together in `endTurn`, so it fires exactly once per turn.
  const turnPhase = useTurnStore.use.phase();
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();
  const activeInProgress =
    isSending(turnPhase) ||
    (!!activeConversationId &&
      processingConversationIds.has(activeConversationId));
  const wasInProgressRef = useRef(false);
  useEffect(() => {
    const justFinished = wasInProgressRef.current && !activeInProgress;
    wasInProgressRef.current = activeInProgress;
    if (justFinished) refetchHistoryOnTurnEnd();
  }, [activeInProgress, refetchHistoryOnTurnEnd]);

  // -------------------------------------------------------------------------
  // Refetch history when the SSE connection reopens after a disconnect.
  //
  // The daemon's replay ring only holds ~30s of events, so a connection that
  // reopens later than that (device slept, tab backgrounded) can't be
  // ring-replayed. Invalidating routes the catch-up through the normal fetch
  // path; the monotonic seq baseline makes it a no-op when nothing landed.
  // `"fresh"`/`"anchor"` reopens are skipped: the first connect's
  // `refetchOnMount` already loaded the snapshot.
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
  // Sync older-page loading state into the pagination mirror.
  // -------------------------------------------------------------------------
  useEffect(() => {
    setTranscriptPagination((prev) => {
      if (prev.isLoadingOlder === pagination.isFetchingOlderPages) return prev;
      return { ...prev, isLoadingOlder: pagination.isFetchingOlderPages };
    });
  }, [pagination.isFetchingOlderPages, setTranscriptPagination]);

  // -------------------------------------------------------------------------
  // Surface TanStack Query errors.
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
