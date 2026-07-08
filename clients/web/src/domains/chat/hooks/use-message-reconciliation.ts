import { useCallback, useLayoutEffect, useRef } from "react";

import * as Sentry from "@sentry/react";

import { useQueryClient } from "@tanstack/react-query";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { bucketMessagesAdded, recordDiagnostic, resolvePlatformTag } from "@/lib/diagnostics";
import { summarizeRuntimeMessages } from "@/domains/chat/utils/diagnostics";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { recordLocalSeq } from "@/lib/streaming/local-seq";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import { conversationHistoryQueryKey } from "@/domains/chat/transcript/use-history-pagination";
import { patchConversation } from "@/utils/conversation-cache";
import {
  serverHasAssistantProgress,
  serverSnapshotHasNewContent,
} from "@/domains/chat/utils/reconcile-detection";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { ingestServerEventsTail } from "@/domains/chat/api/events-tail";
import { supportsEventsTail } from "@/lib/backwards-compat/events-tail";
import {
  fetchConversationMessages,
  RECONCILE_LATEST_PAGE_LIMIT,
} from "@/domains/chat/api/messages";
import type { ConversationMessage } from "@vellumai/assistant-api";
import { useConversationStore } from "@/stores/conversation-store";
import { endTurn } from "@/domains/chat/turn-coordinator";

const RECONCILE_DELAY_MS = 5000;
const RECONCILE_MAX_MS = 60_000;
const RECONCILE_STABLE_COUNT = 2;

interface UseMessageReconciliationArgs {
  latestPageOldestTimestamp: number | null;
}

/** Result of reconciling the active conversation against the server. */
export interface ReconcileActiveConversationResult {
  /** The server snapshot carries content the local view does not yet show. */
  changed: boolean;
  /** Number of messages the server view has beyond the local view. */
  messagesAdded: number;
  /** Whether the server's view of the current turn shows assistant progress
   *  beyond what the local view has — i.e., genuine new content the
   *  silent-stall caused us to miss, not just bookkeeping diffs. */
  assistantProgress: boolean;
}

interface UseMessageReconciliationReturn {
  reconcileFromServer: (
    serverMessages: ConversationMessage[],
    conversationId: string,
    serverSeq: number | null,
  ) => boolean;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  /** Fetches the latest messages, refreshes the history cache, and reconciles
   *  turn state (dispatches POLL_RECONCILED when the turn is stuck in a
   *  sending phase). Pass `authoritative` to force a history refetch
   *  regardless of whether the snapshot looks changed — set by reconnect
   *  reconciles, where the live suffix may be non-contiguous. */
  reconcileActiveConversation: (
    authoritative?: boolean,
  ) => Promise<ReconcileActiveConversationResult>;
}

export function useMessageReconciliation({
  latestPageOldestTimestamp,
}: UseMessageReconciliationArgs): UseMessageReconciliationReturn {
  const initialPageOldestTsRef = useRef<number | null>(latestPageOldestTimestamp);
  useLayoutEffect(() => {
    initialPageOldestTsRef.current = latestPageOldestTimestamp;
  }, [latestPageOldestTimestamp]);
  const queryClient = useQueryClient();
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelReconciliation = useCallback(() => {
    // Below-floor only. The poll loop is the sole thing that arms a timer,
    // and it runs only below the events-tail floor. At/above the floor
    // there is no loop, so the cancel is fully off.
    if (supportsEventsTail()) return;
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
      recordDiagnostic("reconciliation_loop_cancelled", {});
    }
  }, []);

  // The transcript the user currently sees: the materialized snapshot overlaid
  // with the client's optimistic sends — the same union `useTranscriptMessages`
  // renders. Compared against the server snapshot to detect missed content.
  const currentLocalView = useCallback((): DisplayMessage[] => {
    const { snapshot, optimisticSends } = useChatSessionStore.getState();
    return selectTranscriptMessages(snapshot?.messages ?? [], optimisticSends);
  }, []);

  const reconcileFromServerDetailed = useCallback(
    (
      serverMessages: ConversationMessage[],
      conversationId: string,
      serverSeq: number | null,
      serverProcessing: boolean | undefined,
      authoritative = false,
    ): {
      changed: boolean;
      assistantProgress: boolean;
      messagesAdded: number;
    } => {
      if (serverMessages.length === 0) {
        recordDiagnostic("reconciliation_skipped_empty_server", {});
        return { changed: false, assistantProgress: false, messagesAdded: 0 };
      }

      // Advance the local seq frontier — we've observed this server snapshot.
      recordLocalSeq(conversationId, serverSeq);

      const localView = currentLocalView();
      const serverView = serverMessages.map(mapRuntimeToDisplayMessage);
      const assistantProgress = serverHasAssistantProgress(
        localView,
        serverView,
        isSending(useTurnStore.getState().phase),
      );
      const changed = serverSnapshotHasNewContent(serverView, localView);
      // Count server rows absent from the local view by id rather than a raw
      // length diff: the server snapshot is the latest page only, while the
      // local view spans every loaded page, so a length subtraction would go
      // negative once older history is paged in. Counting unmatched ids stays
      // correct under that windowing (this feeds diagnostics / the Sentry
      // rescue breadcrumb, not control flow).
      const localIds = new Set<string>();
      for (const m of localView) {
        if (m.id) localIds.add(m.id);
      }
      const messagesAdded = serverView.reduce(
        (count, sm) => (sm.id && !localIds.has(sm.id) ? count + 1 : count),
        0,
      );

      // Adopt the daemon's authoritative `processing` flag when it reports the
      // conversation idle but our rolling snapshot still shows it processing.
      // This is the sole path that samples the flag independently of the SSE
      // stream, so it's the only place that learns a turn ended when the
      // terminal event (`message_complete` / `assistant_activity_state(idle)`)
      // was dropped on a disconnect. Propagating it lets the existing
      // authoritative CLOSE-gate in `shouldShowThinkingIndicator` /
      // `isAssistantBusy` (`snapshotProcessing === false`) settle the turn —
      // no client-side stuck-turn heuristic. `undefined` (older daemons) does
      // nothing, preserving prior behavior.
      const localSnapshotProcessing =
        useChatSessionStore.getState().snapshot?.processing;
      const serverClearedProcessing =
        serverProcessing === false && localSnapshotProcessing === true;

      // Refresh the single source — history flows into the query cache and the
      // transcript (its union with the live turn) re-renders. No client-side
      // merge: the server snapshot is authoritative for persisted history. A
      // reseed also carries the fresh `processing: false` onto the snapshot, so
      // a server-cleared turn reconciles through the same path as new content.
      if (changed || authoritative || serverClearedProcessing) {
        const assistantId =
          useStreamStore.getState().streamContext?.assistantId ?? null;
        if (assistantId) {
          void queryClient.invalidateQueries({
            queryKey: conversationHistoryQueryKey(assistantId, conversationId),
          });
          if (serverClearedProcessing) {
            // Mirror the terminal handlers' cache patch so the conversation-row
            // half of the processing state (sidebar dot, `activeConversation
            // ?.isProcessing`) can't stay latched `true` after the server has
            // gone idle. See `handleMessageComplete`.
            patchConversation(queryClient, assistantId, conversationId, {
              isProcessing: false,
            });
          }
        }
      }

      if (serverClearedProcessing) {
        recordDiagnostic("reconciliation_processing_cleared", {
          conversationId,
          changed,
          assistantProgress,
        });
      }

      recordDiagnostic("reconciliation_applied", {
        changed,
        assistantProgress,
        messagesAdded,
        authoritative,
        serverProcessing,
        oldestPageTimestamp: initialPageOldestTsRef.current,
        server: summarizeRuntimeMessages(serverMessages),
      });

      return { changed, assistantProgress, messagesAdded };
    },
    [currentLocalView, queryClient],
  );

  const reconcileFromServer = useCallback(
    (
      serverMessages: ConversationMessage[],
      conversationId: string,
      serverSeq: number | null,
    ): boolean =>
      reconcileFromServerDetailed(
        serverMessages,
        conversationId,
        serverSeq,
        undefined,
      ).changed,
    [reconcileFromServerDetailed],
  );

  const reconcileFetchedMessages = useCallback(
    (
      serverMessages: ConversationMessage[],
      snapshotTurnId: string | null,
      snapshotConversationId: string,
      serverSeq: number | null,
      serverProcessing: boolean | undefined,
      authoritative = false,
    ): ReconcileActiveConversationResult => {
      const { changed, assistantProgress, messagesAdded } =
        reconcileFromServerDetailed(
          serverMessages,
          snapshotConversationId,
          serverSeq,
          serverProcessing,
          authoritative,
        );

      // Reconcile turn state: only fire the silent-stall rescue when ALL
      // of these hold:
      //   - `changed`: the server snapshot carries content the local view
      //     doesn't have. Without this gate the rescue would fire on every
      //     sync-tag reconcile that lands mid-stream, because
      //     `assistantProgress` returns true the moment we have a
      //     local-streaming row matched to a server row — that's the exact
      //     normal mid-stream state, not a stuckness signal.
      //   - `assistantProgress`: server-confirmed evidence that the
      //     assistant turn produced output (matched row with newer
      //     content, or an additional assistant message). Gates out
      //     refetches that only e.g. assigned an id to an optimistic
      //     user row.
      //   - Same turn id we snapshotted at fetch time, and the store
      //     still says we're sending.
      //
      // The case where SSE missed the terminal event but the server's
      // persisted view already matches what local rendered (`changed`
      // false) is handled separately, upstream: `reconcileFromServerDetailed`
      // adopts the server's `processing: false` onto the snapshot, and the
      // `snapshotProcessing` CLOSE-gate in `shouldShowThinkingIndicator`
      // settles the indicator without a content diff.
      const wasStuck =
        changed &&
        assistantProgress &&
        snapshotTurnId &&
        isSending(useTurnStore.getState().phase) &&
        useTurnStore.getState().activeTurnId === snapshotTurnId;
      if (wasStuck) {
        // The rescue must clear BOTH the turn-store (so the local
        // lifecycle becomes idle) AND the conversation-level processing
        // key (so `isAssistantBusy` and the sidebar processing dot
        // can settle). `endTurn` does both atomically — without that
        // pairing the rescue would leave `activeConversationIsProcessing`
        // stuck because the graduation effect in `useAttentionTracking`
        // explicitly skips the active conversation, making this the
        // only path that clears it when SSE drops the terminal event.
        endTurn({
          conversationId: snapshotConversationId,
          reason: "rescued",
          rescuedTurnId: snapshotTurnId,
        });
        // `POLL_RECONCILED` is the silent-stall rescue: the server
        // reports assistant progress that the client never observed
        // via SSE, meaning a terminal event (`message_complete`
        // and/or `assistant_activity_state(idle)`) was lost in
        // flight. Mirror to Sentry for fleet-wide aggregation;
        // sessionStorage diagnostics alone ship only via user
        // support bundles, biasing the sample toward broken-and-
        // noisy cases. See
        // https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
        Sentry.addBreadcrumb({
          category: "sse.terminal",
          level: "warning",
          message: "poll_reconciled_rescue",
          data: { messagesAdded, turnId: snapshotTurnId },
        });
        Sentry.captureMessage("sse_poll_reconciled_rescue", {
          level: "warning",
          tags: {
            context: "sse_terminal",
            platform: resolvePlatformTag(),
            messagesAddedBucket: bucketMessagesAdded(messagesAdded),
          },
          extra: { messagesAdded, turnId: snapshotTurnId },
        });
      }

      return { changed, assistantProgress, messagesAdded };
    },
    [reconcileFromServerDetailed],
  );

  const reconcileActiveConversation = useCallback(
    async (
      authoritative = false,
    ): Promise<ReconcileActiveConversationResult> => {
      const empty: ReconcileActiveConversationResult = {
        changed: false,
        messagesAdded: 0,
        assistantProgress: false,
      };
      const streamState = useStreamStore.getState();
      const ctx = streamState.streamContext;
      if (!ctx) return empty;

      // Snapshot the turn identity before the async fetch so the
      // POLL_RECONCILED dispatch is scoped to THIS turn. If the user
      // starts a new send while the fetch is in-flight, the turnId guard
      // in the store prevents stale reconciliation from idling it.
      const snapshotTurnId = useTurnStore.getState().activeTurnId;
      const snapshotEpoch = streamState.streamEpoch;

      try {
        const snapshot = await fetchConversationMessages(
          ctx.assistantId,
          ctx.conversationId,
          { latestPageLimit: RECONCILE_LATEST_PAGE_LIMIT },
        );
        const serverMessages = snapshot?.messages ?? [];
        const serverSeq = snapshot?.seq ?? null;
        const serverProcessing = snapshot?.processing;
        if (useConversationStore.getState().activeConversationId !== ctx.conversationId) return empty;
        // If the epoch changed during the fetch (e.g. page went hidden
        // and back), this reconciliation is stale — bail out.
        if (useStreamStore.getState().streamEpoch !== snapshotEpoch) return empty;
        // Pair the snapshot with the daemon's buffered event tail above its
        // anchor BEFORE reconciling: the reconcile invalidates history, and
        // the reseed replay reads the client event ring — priming it first
        // lets the reseed fold events the live connection never delivered
        // (snapshot at anchor + log from anchor), instead of trusting the
        // snapshot alone. No-op below the events-tail floor.
        await ingestServerEventsTail(
          ctx.assistantId,
          ctx.conversationId,
          serverSeq,
        );
        if (useConversationStore.getState().activeConversationId !== ctx.conversationId) return empty;
        if (useStreamStore.getState().streamEpoch !== snapshotEpoch) return empty;
        recordDiagnostic("reconciliation_active_fetch", {
          assistantId: ctx.assistantId,
          conversationId: ctx.conversationId,
          epoch: snapshotEpoch,
          serverProcessing,
          server: summarizeRuntimeMessages(serverMessages),
        });
        return reconcileFetchedMessages(
          serverMessages,
          snapshotTurnId,
          ctx.conversationId,
          serverSeq,
          serverProcessing,
          authoritative,
        );
      } catch (err) {
        // Re-throw so callers that await the result (e.g. the
        // reconnect-recovery reconcile in reconcile-on-reopen) can
        // distinguish "fetch succeeded, nothing new" from "fetch failed."
        // Fire-and-forget callers already have their own .catch() handlers.
        recordDiagnostic("reconciliation_active_fetch_error", {
          assistantId: ctx.assistantId,
          conversationId: ctx.conversationId,
          epoch: snapshotEpoch,
        });
        throw err;
      }
    },
    [
    reconcileFetchedMessages,
  ]);

  const startReconciliationLoop = useCallback(
    (epoch: number) => {
      // Below-floor only. At/above the events-tail floor there is no poll
      // loop: recovery is driven entirely by the event-triggered
      // `reconcileActiveConversation()` calls (reopen / seq-gap /
      // sync-tag), which pair the snapshot with the `/events/tail`
      // catch-up. So the loop-invoking method is fully off above the floor
      // and the callers' invocations become no-ops there. Below the floor
      // the daemon doesn't serve the endpoint, so the poll-until-stable
      // loop is retained to wait out the partial-persist debounce.
      if (supportsEventsTail()) return;

      cancelReconciliation();
      recordDiagnostic("reconciliation_loop_start", { epoch });

      const startTime = Date.now();
      let stableCount = 0;

      const tick = () => {
        reconcileTimerRef.current = null;
        const ctx = useStreamStore.getState().streamContext;
        if (!ctx || epoch !== useStreamStore.getState().streamEpoch) {
          recordDiagnostic("reconciliation_loop_finish", {
            epoch,
            reason: !ctx ? "no_context" : "epoch_changed",
            stableCount,
            elapsedMs: Date.now() - startTime,
          });
          return;
        }
        if (Date.now() - startTime >= RECONCILE_MAX_MS) {
          recordDiagnostic("reconciliation_loop_finish", {
            epoch,
            reason: "max_duration",
            stableCount,
            elapsedMs: Date.now() - startTime,
          });
          return;
        }
        const snapshotTurnId = useTurnStore.getState().activeTurnId;

        fetchConversationMessages(ctx.assistantId, ctx.conversationId, {
          latestPageLimit: RECONCILE_LATEST_PAGE_LIMIT,
        })
          .then((snapshot) => {
            if (epoch !== useStreamStore.getState().streamEpoch) return;
            const serverMessages = snapshot?.messages ?? [];
            const serverSeq = snapshot?.seq ?? null;
            const serverProcessing = snapshot?.processing;
            recordDiagnostic("reconciliation_fetch", {
              assistantId: ctx.assistantId,
              conversationId: ctx.conversationId,
              epoch,
              stableCount,
              serverProcessing,
              server: summarizeRuntimeMessages(serverMessages),
            });

            const { changed } = reconcileFetchedMessages(
              serverMessages,
              snapshotTurnId,
              ctx.conversationId,
              serverSeq,
              serverProcessing,
            );

            if (changed) {
              stableCount = 0;
            } else {
              stableCount++;
            }

            if (stableCount >= RECONCILE_STABLE_COUNT) {
              recordDiagnostic("reconciliation_loop_finish", {
                epoch,
                reason: "stable",
                stableCount,
                elapsedMs: Date.now() - startTime,
              });
              return;
            }
            if (epoch !== useStreamStore.getState().streamEpoch) {
              recordDiagnostic("reconciliation_loop_finish", {
                epoch,
                reason: "epoch_changed_post_fetch",
                stableCount,
                elapsedMs: Date.now() - startTime,
              });
              return;
            }
            reconcileTimerRef.current = setTimeout(tick, RECONCILE_DELAY_MS);
          })
          .catch(() => {
            if (epoch !== useStreamStore.getState().streamEpoch) {
              recordDiagnostic("reconciliation_loop_finish", {
                epoch,
                reason: "epoch_changed_post_error",
                stableCount,
                elapsedMs: Date.now() - startTime,
              });
              return;
            }
            recordDiagnostic("reconciliation_fetch_error", {
              assistantId: ctx.assistantId,
              conversationId: ctx.conversationId,
              epoch,
              stableCount,
            });
            reconcileTimerRef.current = setTimeout(tick, RECONCILE_DELAY_MS);
          });
      };

      reconcileTimerRef.current = setTimeout(tick, RECONCILE_DELAY_MS);
    },
    [cancelReconciliation, reconcileFetchedMessages],
  );

  return {
    reconcileFromServer,
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
