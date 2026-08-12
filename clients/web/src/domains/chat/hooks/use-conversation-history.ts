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
 * - **The snapshot reporting `processing: true` with nothing local agreeing**:
 *   the daemon's flag alone is holding the UI busy, so revalidate on a timer
 *   until a reseed reports the conversation idle. This is the only exit from
 *   that state, since no local signal is left to fall.
 *
 * Conversation-switch resets are owned by the store's `switchToConversation()`.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries}
 */

import { captureError } from "@/lib/sentry/capture-error";
import { useCallback, useEffect, useRef } from "react";

import { type InfiniteData, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingSummaryRetrieveQueryKey,
  organizationsBillingUsageTotalsRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceQueryEnabled } from "@/hooks/use-billing-balance-status";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useResumeGrace } from "@/hooks/use-resume-grace";
import {
  extractWirePendingAcpConnect,
  extractWirePendingConfirmation,
  extractWirePendingQuestion,
} from "@/domains/chat/utils/chat";
import { mapMessageSurfaces } from "@/domains/chat/utils/map-message-surfaces";
import { recordDiagnostic } from "@/lib/diagnostics";
import { recordServerSeq } from "@/lib/streaming/server-seq";
import { recordLocalSeq } from "@/lib/streaming/local-seq";
import { getSeqGeneration } from "@/lib/streaming/reconnect-cursor";
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
 * How often the history snapshot is revalidated while the daemon's
 * `processing: true` flag is the only thing holding the UI in its busy state
 * (Stop button, spinner, no send affordance).
 *
 * `isAssistantBusy` treats that flag as authoritative, so nothing local can
 * retire it: the local phase is already idle and no assistant row is streaming,
 * which is precisely why the falling-edge reseed below never fires. Re-reading
 * `/messages` on this cadence is what turns the flag back to `false` once the
 * daemon releases the lock, bounding how long a stale `true` can hold the UI
 * busy. Short enough that a user staring at a wedged Stop button gets out
 * quickly, long enough that it costs one request per few seconds in a state
 * that is already anomalous.
 */
export const SERVER_PROCESSING_REVALIDATE_MS = 4_000;

/**
 * Structural equality for surface `data` payloads. Both sides come from the
 * same daemon surface-content endpoint, so a stable JSON serialization compares
 * correctly here. Used to skip no-op surface-content cache writes that would
 * otherwise re-trigger the `dataUpdatedAt`-keyed snapshot effect and loop.
 */
function surfaceContentEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
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
    enabled:
      assistantStateKind === "active" &&
      !!assistantId &&
      !!activeConversationId,
  });

  const setIsLoadingHistory = useChatSessionStore.use.setIsLoadingHistory();
  const setTranscriptPagination =
    useChatSessionStore.use.setTranscriptPagination();
  const setError = useChatSessionStore.use.setError();

  // -------------------------------------------------------------------------
  // Conversation-switch reset — delegated to the store action.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
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
        if (!old) {
          return old;
        }
        let changed = false;
        const pages = old.pages.map((page) => {
          const next = updater(page.messages);
          if (next === page.messages) {
            return page;
          }
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

    // Seq baseline (replay idempotency) + cold-start ring-replay anchor. Tag
    // the frontier with the generation the page's `/messages` request was
    // issued in (falling back to the current generation for pages that carry no
    // stamped generation) so a page that raced a generation reset is recognised
    // as a stale anchor by the stale-frontier guard rather than starving the
    // stream.
    const latestPageSeq = pagination.latestPage?.seq ?? null;
    const latestPageGeneration =
      pagination.latestPage?.seqGeneration ?? getSeqGeneration();
    recordServerSeq(activeConversationId, latestPageSeq);
    recordLocalSeq(activeConversationId, latestPageSeq, latestPageGeneration);
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
    if (
      wirePendingQuestion &&
      !useInteractionStore.getState().pendingQuestion
    ) {
      useInteractionStore.getState().showQuestion(wirePendingQuestion);
    }

    // Restore the inline "Connect Claude Code" card the snapshot carries on a
    // failed acp_spawn (persisted `acp_claude_oauth_missing` marker). Without
    // this, a page reload or SSE reconnect wipes the in-memory prompt and the
    // card silently disappears. Skipped when a prompt is already active;
    // `showAcpConnect` additionally no-ops a failure the user already dismissed
    // this session, so a reseed can't resurrect a card after dismiss-on-send.
    const wirePendingAcpConnect = extractWirePendingAcpConnect(
      pagination.messages,
    );
    if (
      wirePendingAcpConnect &&
      !useInteractionStore.getState().pendingAcpConnect
    ) {
      useInteractionStore.getState().showAcpConnect(wirePendingAcpConnect);
    }

    // Refresh embedded surface content into the history cache.
    const requestedConversationForSurfaces = activeConversationId;
    for (const msg of pagination.messages) {
      if (!msg.surfaces) {
        continue;
      }
      for (const surface of msg.surfaces) {
        fetchSurfaceContent(
          assistantId,
          surface.surfaceId,
          activeConversationId,
        ).then((fresh) => {
          if (!fresh) {
            return;
          }
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
              if (!old) {
                return old;
              }
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
                    if (s.surfaceId !== fresh.surfaceId) {
                      return s;
                    }
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
        activeConversationId,
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
  //
  // -------------------------------------------------------------------------
  const refetchHistoryOnTurnEnd = useCallback(() => {
    if (!assistantId || !activeConversationId) {
      return;
    }
    void pagination.invalidate();
  }, [assistantId, activeConversationId, pagination]);

  // The billing summary is invalidated on its own falling edge below: every
  // turn in ANY conversation (including a background turn run from an
  // external channel or another client, and one that fails on exhausted
  // credits) can move the org-wide credit balance, and the balance surfaces
  // should reflect it without waiting for the staleTime window. Gated exactly
  // like `useBillingBalanceStatus` so self-hosted / org-not-ready contexts,
  // where the query never runs, skip it.
  const billingSummaryEnabled = useBillingBalanceQueryEnabled();
  const invalidateBillingSummary = useCallback(() => {
    if (billingSummaryEnabled) {
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveQueryKey(),
      });
      // The BYOK banner gate's recent-spend probe
      // (`useSuppressCreditBannersForByok`) must see a managed burn from this
      // turn too, or a cached zero keeps suppressing the banners in an open
      // tab. Its key carries a from/to window, so match on the key's base
      // fields (derived from the generated key builder, minus the window)
      // to hit every cached window.
      const [totalsKey] = organizationsBillingUsageTotalsRetrieveQueryKey({
        query: { from: "", to: "" },
      });
      const { query: _window, ...totalsKeyBase } = totalsKey;
      void queryClient.invalidateQueries({ queryKey: [totalsKeyBase] });
    }
  }, [billingSummaryEnabled, queryClient]);

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
    if (justFinished) {
      refetchHistoryOnTurnEnd();
    }
  }, [activeInProgress, refetchHistoryOnTurnEnd]);

  // Billing tracks turn ends across ALL conversations, not just the active
  // one: a background turn (external channel, other client) spends the same
  // org-wide balance. Each conversation leaving the processing set fires its
  // own invalidation, so one turn's spend is never masked by another turn
  // still running (a turn parked at `awaiting_user_input` can hold a
  // combined signal for minutes). The local-send falling edge is the
  // fallback for a send whose conversation never got flagged processing;
  // when the flag did appear, the set departure owns the invalidation and
  // the send edge stays quiet, so a local turn fires exactly once.
  const sendingNow = isSending(turnPhase);
  const prevProcessingRef = useRef(processingConversationIds);
  const wasSendingRef = useRef(false);
  const activeSendTrackedRef = useRef(false);
  useEffect(() => {
    const prevProcessing = prevProcessingRef.current;
    prevProcessingRef.current = processingConversationIds;
    const sendJustEnded = wasSendingRef.current && !sendingNow;
    wasSendingRef.current = sendingNow;

    if (
      sendingNow &&
      !!activeConversationId &&
      processingConversationIds.has(activeConversationId)
    ) {
      activeSendTrackedRef.current = true;
    }

    let anyTurnDeparted = false;
    for (const id of prevProcessing) {
      if (!processingConversationIds.has(id)) {
        anyTurnDeparted = true;
        break;
      }
    }

    if (anyTurnDeparted) {
      invalidateBillingSummary();
    } else if (sendJustEnded && !activeSendTrackedRef.current) {
      invalidateBillingSummary();
    }
    if (sendJustEnded) {
      activeSendTrackedRef.current = false;
    }
  }, [
    processingConversationIds,
    sendingNow,
    activeConversationId,
    invalidateBillingSummary,
  ]);

  // -------------------------------------------------------------------------
  // Server-processing revalidation. The daemon's snapshot `processing` flag is
  // authoritative for `isAssistantBusy`, so when it reads `true` while nothing
  // local agrees (idle phase, conversation not flagged processing) it is the
  // sole thing rendering the busy affordances, and the falling-edge reseed
  // above can never fire to retire it. Poll `/messages` for exactly as long as
  // that holds: the first reseed carrying `processing: false` clears the busy
  // state through the existing close-gate and stops the timer. `invalidate` is
  // stable per conversation, so the interval is armed once per episode rather
  // than restarted on every render.
  // -------------------------------------------------------------------------
  const snapshotProcessing = useChatSessionStore((s) => s.snapshot?.processing);
  const serverProcessingIsSoleBusySignal =
    snapshotProcessing === true && !activeInProgress;
  const invalidateHistory = pagination.invalidate;
  useEffect(() => {
    if (
      !serverProcessingIsSoleBusySignal ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    const timer = setInterval(() => {
      void invalidateHistory();
    }, SERVER_PROCESSING_REVALIDATE_MS);
    return () => clearInterval(timer);
  }, [
    serverProcessingIsSoleBusySignal,
    assistantId,
    activeConversationId,
    invalidateHistory,
  ]);

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
  useBusSubscription(
    "sse.opened",
    ({ assistantId: openedAssistantId, cause }) => {
      if (cause === "fresh" || cause === "anchor") {
        return;
      }
      if (
        assistantStateKind !== "active" ||
        !assistantId ||
        !activeConversationId ||
        openedAssistantId !== assistantId
      ) {
        return;
      }
      void pagination.invalidate();
    },
  );

  // -------------------------------------------------------------------------
  // Sync older-page loading state into the pagination mirror.
  // -------------------------------------------------------------------------
  useEffect(() => {
    setTranscriptPagination((prev) => {
      if (prev.isLoadingOlder === pagination.isFetchingOlderPages) {
        return prev;
      }
      return { ...prev, isLoadingOlder: pagination.isFetchingOlderPages };
    });
  }, [pagination.isFetchingOlderPages, setTranscriptPagination]);

  // -------------------------------------------------------------------------
  // Surface TanStack Query errors.
  //
  // An initial-page failure inside the resume grace window is held back: the
  // refetch that fires when the client returns from the background often
  // fails transiently against a still-waking pod. It is still reported, and
  // the blocking error surfaces once the window expires.
  // -------------------------------------------------------------------------
  const isResumeGraceActive = useResumeGrace();
  useEffect(() => {
    if (!pagination.isError || !pagination.error) {
      return;
    }

    const isOlderPageError = pagination.isSuccess;
    captureError(pagination.error, {
      context: isOlderPageError
        ? "conversation_history_older_page"
        : "conversation_history_initial",
    });

    if (!isOlderPageError) {
      setIsLoadingHistory(false);
      if (!isResumeGraceActive) {
        setError({
          message: "Failed to load conversation history. Please try again.",
        });
      }
    }
  }, [
    pagination.isError,
    pagination.isSuccess,
    pagination.error,
    isResumeGraceActive,
    setIsLoadingHistory,
    setError,
  ]);

  return { pagination };
}
