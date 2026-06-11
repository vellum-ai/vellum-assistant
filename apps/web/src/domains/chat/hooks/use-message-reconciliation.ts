import { useCallback, useLayoutEffect, useRef } from "react";

import * as Sentry from "@sentry/react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { bucketMessagesAdded, recordDiagnostic, resolvePlatformTag } from "@/lib/diagnostics";
import {
  summarizeDisplayMessages,
  summarizeRuntimeMessages,
} from "@/domains/chat/utils/diagnostics";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { reconcileSnapshot } from "@/domains/chat/utils/reconcile-snapshot";
import { getLocalSeq, recordLocalSeq } from "@/lib/streaming/local-seq";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { fetchConversationMessages } from "@/domains/chat/api/messages";
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
  /** Any field on any message changed (added, content edit, id assignment,
   *  etc.). */
  changed: boolean;
  /** Number of messages added relative to the local state, computed as
   *  `next.length - prev.length`. Used to distinguish "watchdog-triggered
   *  reconcile rescued real assistant content" from "watchdog churn that
   *  only refreshed metadata on existing messages." */
  messagesAdded: number;
  /** Whether the server's view of the current turn shows assistant
   *  progress beyond what the local view has — i.e., genuine new content
   *  the silent-stall caused us to miss, not just bookkeeping diffs. */
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
  /** Fetches the latest messages, reconciles them, and reconciles turn
   *  state (dispatches POLL_RECONCILED when the turn is stuck in a
   *  sending phase). */
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

function serverHasAssistantProgress(
  localMessages: DisplayMessage[],
  serverMessages: ConversationMessage[],
  isProcessing: boolean,
): boolean {
  const liveRowId = liveAssistantRowId(localMessages, isProcessing);
  const lastLocalUserIndex = localMessages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentTurnLocalMessages =
    lastLocalUserIndex >= 0
      ? localMessages.slice(lastLocalUserIndex + 1)
      : localMessages;
  const localAssistants = currentTurnLocalMessages.filter(
    (message) => message.role === "assistant",
  );
  const localAssistantById = new Map<string, DisplayMessage>();
  const claimedLocal = new Set<DisplayMessage>();

  for (const message of localAssistants) {
    if (message.id) {
      localAssistantById.set(message.id, message);
    }
  }

  let serverSearchStartIndex = 0;
  if (lastLocalUserIndex >= 0) {
    const lastLocalUser = localMessages[lastLocalUserIndex]!;
    const lastLocalUserText = messagePlainText(lastLocalUser);
    const serverUserIndex = serverMessages.findLastIndex((message) => {
      if (message.role !== "user") return false;
      if (lastLocalUser.id && message.id === lastLocalUser.id) return true;
      return (
        messagePlainText(mapRuntimeToDisplayMessage(message)) ===
        lastLocalUserText
      );
    });
    if (serverUserIndex === -1) return false;
    serverSearchStartIndex = serverUserIndex + 1;
  }

  for (const serverMessage of serverMessages.slice(serverSearchStartIndex)) {
    if (serverMessage.role !== "assistant") continue;

    const serverMessageText = messagePlainText(
      mapRuntimeToDisplayMessage(serverMessage),
    );
    const localById = localAssistantById.get(serverMessage.id);
    if (localById) {
      claimedLocal.add(localById);
      if (localById.id === liveRowId) return true;
      if (messagePlainText(localById) !== serverMessageText)
        return true;
      continue;
    }

    const localByContent = localAssistants.find(
      (message) =>
        !claimedLocal.has(message) &&
        messagePlainText(message) === serverMessageText,
    );
    if (localByContent) {
      claimedLocal.add(localByContent);
      if (localByContent.id === liveRowId) return true;
      continue;
    }

    return true;
  }

  return false;
}

export function useMessageReconciliation({
  latestPageOldestTimestamp,
}: UseMessageReconciliationArgs): UseMessageReconciliationReturn {
  const initialPageOldestTsRef = useRef<number | null>(latestPageOldestTimestamp);
  useLayoutEffect(() => {
    initialPageOldestTsRef.current = latestPageOldestTimestamp;
  }, [latestPageOldestTimestamp]);
  const setMessages = useChatSessionStore.use.setMessages();
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelReconciliation = useCallback(() => {
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
      recordDiagnostic("reconciliation_loop_cancelled", {});
    }
  }, []);

  const reconcileFromServerDetailed = useCallback(
    (
      serverMessages: ConversationMessage[],
      conversationId: string,
      serverSeq: number | null,
    ): {
      changed: boolean;
      assistantProgress: boolean;
      messagesAdded: number;
    } => {
      if (serverMessages.length === 0) {
        recordDiagnostic("reconciliation_skipped_empty_server", {});
        return { changed: false, assistantProgress: false, messagesAdded: 0 };
      }

      // Capture the local seq `L` before advancing it, so the merge
      // can tell whether this snapshot moved the frontier (`S > L`). Then
      // advance the frontier to the server seq for later consumers.
      // Both run outside the updater so the updater stays pure.
      const localSeq = getLocalSeq(conversationId);
      recordLocalSeq(conversationId, serverSeq);

      let changed = false;
      let assistantProgress = false;
      let messagesAdded = 0;
      let localBefore: Record<string, unknown> | null = null;
      let localAfter: Record<string, unknown> | null = null;
      setMessages((prev) => {
        localBefore = summarizeDisplayMessages(prev);
        assistantProgress = serverHasAssistantProgress(
          prev,
          serverMessages,
          isSending(useTurnStore.getState().phase),
        );
        const next = reconcileSnapshot(prev, serverMessages, {
          serverSeq,
          localSeq,
          oldestPageTimestamp: initialPageOldestTsRef.current,
        });
        changed = next !== prev;
        // The "added" count is what telemetry uses to distinguish a
        // reconcile that rescued genuinely-missed content (positive)
        // from one that only refreshed metadata on existing rows (zero
        // or negative, e.g. when a duplicate optimistic message gets
        // collapsed into its server-id sibling).
        messagesAdded = next.length - prev.length;
        localAfter = summarizeDisplayMessages(next);
        return next;
      });
      recordDiagnostic("reconciliation_applied", {
        changed,
        assistantProgress,
        messagesAdded,
        oldestPageTimestamp: initialPageOldestTsRef.current,
        server: summarizeRuntimeMessages(serverMessages),
        localBefore,
        localAfter,
      });

      return { changed, assistantProgress, messagesAdded };
    },
    [initialPageOldestTsRef, setMessages],
  );

  const reconcileFromServer = useCallback(
    (
      serverMessages: ConversationMessage[],
      conversationId: string,
      serverSeq: number | null,
    ): boolean =>
      reconcileFromServerDetailed(serverMessages, conversationId, serverSeq)
        .changed,
    [reconcileFromServerDetailed],
  );

  const reconcileFetchedMessages = useCallback(
    (
      serverMessages: ConversationMessage[],
      snapshotTurnId: string | null,
      snapshotConversationId: string,
      serverSeq: number | null,
    ): ReconcileActiveConversationResult => {
      const { changed, assistantProgress, messagesAdded } =
        reconcileFromServerDetailed(
          serverMessages,
          snapshotConversationId,
          serverSeq,
        );

      // Reconcile turn state: only fire the silent-stall rescue when ALL
      // of these hold:
      //   - `changed`: reconcile produced a structurally different array
      //     (content drift, new messages, etc.). Without this gate the
      //     rescue would fire on every sync-tag reconcile that lands
      //     mid-stream, because `assistantProgress` returns true the
      //     moment we have a local-streaming row matched to a server
      //     row — that's the exact normal mid-stream state, not a
      //     stuckness signal.
      //   - `assistantProgress`: server-confirmed evidence that the
      //     assistant turn produced output (matched row with newer
      //     content, or an additional assistant message). Gates out
      //     refetches that only e.g. assigned an id to an optimistic
      //     user row.
      //   - Same turn id we snapshotted at fetch time, and the store
      //     still says we're sending.
      //
      // Trade-off: in the (rare) case where SSE missed `message_complete`
      // but the server's persisted view exactly matches what local
      // already rendered, this rescue cannot fire. The user would need
      // to reload — but that scenario is also genuinely indistinguishable
      // from "live mid-stream paused between deltas", so the safe call
      // is to never auto-idle without positive structural evidence.
      const wasStuck =
        changed &&
        assistantProgress &&
        snapshotTurnId &&
        isSending(useTurnStore.getState().phase) &&
        useTurnStore.getState().activeTurnId === snapshotTurnId;
      if (wasStuck) {
        // The rescue must clear BOTH the turn-store (so the local
        // lifecycle becomes idle) AND the conversation-level processing
        // key (so `canStopGeneration` and the sidebar processing dot
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

      // Force-complete stale running tool calls. After onPollReconciled the
      // turn is idle. With Zustand, getState() reflects the update
      // immediately.
      if (wasStuck || !isSending(useTurnStore.getState().phase)) {
        setMessages((prev) => {
          const hasStaleToolCalls = prev.some((m) =>
            m.toolCalls?.some((tc) => isToolCallRunning(tc)),
          );
          if (!hasStaleToolCalls) return prev;
          const completedAt = Date.now();
          return prev.map((m) =>
            mapMessageToolCalls(m, (tc) =>
              isToolCallRunning(tc) ? { ...tc, completedAt } : tc,
            ),
          );
        });
      }

      return { changed, assistantProgress, messagesAdded };
    },
    [reconcileFromServerDetailed, setMessages],
  );

  const startReconciliationLoop = useCallback(
    (epoch: number) => {
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

        fetchConversationMessages(ctx.assistantId, ctx.conversationId)
          .then((snapshot) => {
            if (epoch !== useStreamStore.getState().streamEpoch) return;
            const serverMessages = snapshot?.messages ?? [];
            const serverSeq = snapshot?.seq ?? null;
            recordDiagnostic("reconciliation_fetch", {
              assistantId: ctx.assistantId,
              conversationId: ctx.conversationId,
              epoch,
              stableCount,
              server: summarizeRuntimeMessages(serverMessages),
            });

            const { changed } = reconcileFetchedMessages(
              serverMessages,
              snapshotTurnId,
              ctx.conversationId,
              serverSeq,
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
    [
      cancelReconciliation,
      reconcileFetchedMessages,
    ],
  );

  const reconcileActiveConversation = useCallback(
    async (): Promise<ReconcileActiveConversationResult> => {
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
        );
        const serverMessages = snapshot?.messages ?? [];
        const serverSeq = snapshot?.seq ?? null;
        if (useConversationStore.getState().activeConversationId !== ctx.conversationId) return empty;
        // If the epoch changed during the fetch (e.g. page went hidden
        // and back), this reconciliation is stale — bail out.
        if (useStreamStore.getState().streamEpoch !== snapshotEpoch) return empty;
        recordDiagnostic("reconciliation_active_fetch", {
          assistantId: ctx.assistantId,
          conversationId: ctx.conversationId,
          epoch: snapshotEpoch,
          server: summarizeRuntimeMessages(serverMessages),
        });
        return reconcileFetchedMessages(
          serverMessages,
          snapshotTurnId,
          ctx.conversationId,
          serverSeq,
        );
      } catch (err) {
        // Re-throw so callers that observe the promise (e.g. gap-detection
        // cursor advancement) can distinguish "fetch succeeded, nothing new"
        // from "fetch failed." Callers that fire-and-forget already have
        // their own .catch() handlers.
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

  return {
    reconcileFromServer,
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
