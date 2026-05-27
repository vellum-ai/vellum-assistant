import { type Dispatch, type RefObject, type SetStateAction, useCallback, useRef } from "react";

import * as Sentry from "@sentry/browser";

import {
  bucketMessagesAdded,
  recordChatDiagnostic,
  resolvePlatformTag,
  summarizeDisplayMessages,
  summarizeRuntimeMessages,
} from "@/domains/chat/utils/diagnostics";
import { type DisplayMessage, reconcileMessages } from "@/domains/chat/utils/reconcile";
import { isSending, useTurnStore } from "@/domains/messaging/turn-store";
import { fetchConversationMessages, type RuntimeMessage } from "@/domains/chat/api/messages";

const RECONCILE_DELAY_MS = 5000;
const RECONCILE_MAX_MS = 60_000;
const RECONCILE_STABLE_COUNT = 2;

interface UseMessageReconciliationArgs {
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  streamContextRef: RefObject<{ assistantId: string; conversationId: string } | null>;
  streamEpochRef: RefObject<number>;
  activeConversationIdRef: RefObject<string | null>;
  initialPageOldestTsRef: RefObject<number | null>;
}

/** Result of reconciling the active conversation against the server. */
export interface ReconcileActiveConversationResult {
  /** Any field on any message changed (added, content edit, id assignment,
   *  isStreaming flip, etc.). */
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
  reconcileFromServer: (serverMessages: RuntimeMessage[]) => boolean;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  /** Fetches the latest messages, reconciles them, and reconciles turn
   *  state (dispatches POLL_RECONCILED when the turn is stuck in a
   *  sending phase). */
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

function serverHasAssistantProgress(
  localMessages: DisplayMessage[],
  serverMessages: RuntimeMessage[],
): boolean {
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
    const serverUserIndex = serverMessages.findLastIndex((message) => {
      if (message.role !== "user") return false;
      if (lastLocalUser.id && message.id === lastLocalUser.id) return true;
      return message.content === lastLocalUser.content;
    });
    if (serverUserIndex === -1) return false;
    serverSearchStartIndex = serverUserIndex + 1;
  }

  for (const serverMessage of serverMessages.slice(serverSearchStartIndex)) {
    if (serverMessage.role !== "assistant") continue;

    const localById = localAssistantById.get(serverMessage.id);
    if (localById) {
      claimedLocal.add(localById);
      if (localById.isStreaming) return true;
      if (localById.content !== serverMessage.content) return true;
      continue;
    }

    const localByContent = localAssistants.find(
      (message) =>
        !claimedLocal.has(message) &&
        message.content === serverMessage.content,
    );
    if (localByContent) {
      claimedLocal.add(localByContent);
      if (localByContent.isStreaming) return true;
      continue;
    }

    return true;
  }

  return false;
}

export function useMessageReconciliation({
  setMessages,
  streamContextRef,
  streamEpochRef,
  activeConversationIdRef,
  initialPageOldestTsRef,
}: UseMessageReconciliationArgs): UseMessageReconciliationReturn {
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelReconciliation = useCallback(() => {
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
      recordChatDiagnostic("reconciliation_loop_cancelled", {});
    }
  }, []);

  const reconcileFromServerDetailed = useCallback(
    (
      serverMessages: RuntimeMessage[],
    ): {
      changed: boolean;
      assistantProgress: boolean;
      messagesAdded: number;
    } => {
      if (serverMessages.length === 0) {
        recordChatDiagnostic("reconciliation_skipped_empty_server", {});
        return { changed: false, assistantProgress: false, messagesAdded: 0 };
      }

      let changed = false;
      let assistantProgress = false;
      let messagesAdded = 0;
      let localBefore: Record<string, unknown> | null = null;
      let localAfter: Record<string, unknown> | null = null;
      setMessages((prev) => {
        localBefore = summarizeDisplayMessages(prev);
        assistantProgress = serverHasAssistantProgress(prev, serverMessages);
        const next = reconcileMessages(prev, serverMessages, {
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
      recordChatDiagnostic("reconciliation_applied", {
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
    (serverMessages: RuntimeMessage[]): boolean =>
      reconcileFromServerDetailed(serverMessages).changed,
    [reconcileFromServerDetailed],
  );

  const reconcileFetchedMessages = useCallback(
    (
      serverMessages: RuntimeMessage[],
      snapshotTurnId: string | null,
    ): ReconcileActiveConversationResult => {
      const { changed, assistantProgress, messagesAdded } =
        reconcileFromServerDetailed(serverMessages);

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
        isSending(useTurnStore.getState()) &&
        useTurnStore.getState().activeTurnId === snapshotTurnId;
      if (wasStuck) {
        useTurnStore.getState().onPollReconciled(snapshotTurnId);
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
          // platform and messagesAddedBucket are tags (not extras)
          // so they aggregate in Discover. Bucketed (not raw count)
          // to keep tag cardinality bounded.
          // https://docs.sentry.io/concepts/key-terms/key-terms/#tags
          tags: {
            context: "sse_terminal",
            platform: resolvePlatformTag(),
            messagesAddedBucket: bucketMessagesAdded(messagesAdded),
          },
          extra: { messagesAdded, turnId: snapshotTurnId },
        });
      }

      // Clear stale isStreaming flags and force-complete stale running
      // tool calls. After onPollReconciled the turn is idle. With Zustand,
      // getState() reflects the update immediately.
      if (wasStuck || !isSending(useTurnStore.getState())) {
        setMessages((prev) => {
          const hasStaleStreaming = prev.some((m) => m.isStreaming);
          const hasStaleToolCalls = prev.some((m) =>
            m.toolCalls?.some((tc) => tc.status === "running"),
          );
          if (!hasStaleStreaming && !hasStaleToolCalls) return prev;
          return prev.map((m) => {
            const needsClearStreaming = m.isStreaming;
            const needsClearToolCalls = m.toolCalls?.some(
              (tc) => tc.status === "running",
            );
            if (!needsClearStreaming && !needsClearToolCalls) return m;
            return {
              ...m,
              ...(needsClearStreaming ? { isStreaming: false } : {}),
              ...(needsClearToolCalls
                ? {
                    toolCalls: m.toolCalls!.map((tc) =>
                      tc.status === "running"
                        ? {
                            ...tc,
                            status: "completed" as const,
                            completedAt: Date.now(),
                          }
                        : tc,
                    ),
                  }
                : {}),
            };
          });
        });
      }

      return { changed, assistantProgress, messagesAdded };
    },
    [reconcileFromServerDetailed, setMessages],
  );

  const startReconciliationLoop = useCallback(
    (epoch: number) => {
      cancelReconciliation();
      recordChatDiagnostic("reconciliation_loop_start", { epoch });

      const startTime = Date.now();
      let stableCount = 0;

      const tick = () => {
        reconcileTimerRef.current = null;
        const ctx = streamContextRef.current;
        if (!ctx || epoch !== streamEpochRef.current) {
          recordChatDiagnostic("reconciliation_loop_finish", {
            epoch,
            reason: !ctx ? "no_context" : "epoch_changed",
            stableCount,
            elapsedMs: Date.now() - startTime,
          });
          return;
        }
        if (Date.now() - startTime >= RECONCILE_MAX_MS) {
          recordChatDiagnostic("reconciliation_loop_finish", {
            epoch,
            reason: "max_duration",
            stableCount,
            elapsedMs: Date.now() - startTime,
          });
          return;
        }
        const snapshotTurnId = useTurnStore.getState().activeTurnId;

        fetchConversationMessages(ctx.assistantId, ctx.conversationId)
          .then((serverMessages) => {
            if (epoch !== streamEpochRef.current) return;
            recordChatDiagnostic("reconciliation_fetch", {
              assistantId: ctx.assistantId,
              conversationId: ctx.conversationId,
              epoch,
              stableCount,
              server: summarizeRuntimeMessages(serverMessages),
            });

            const { changed } = reconcileFetchedMessages(
              serverMessages,
              snapshotTurnId,
            );
            if (changed) {
              stableCount = 0;
            } else {
              stableCount++;
            }

            if (stableCount >= RECONCILE_STABLE_COUNT) {
              recordChatDiagnostic("reconciliation_loop_finish", {
                epoch,
                reason: "stable",
                stableCount,
                elapsedMs: Date.now() - startTime,
              });
              return;
            }
            if (epoch !== streamEpochRef.current) {
              recordChatDiagnostic("reconciliation_loop_finish", {
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
            if (epoch !== streamEpochRef.current) {
              recordChatDiagnostic("reconciliation_loop_finish", {
                epoch,
                reason: "epoch_changed_post_error",
                stableCount,
                elapsedMs: Date.now() - startTime,
              });
              return;
            }
            recordChatDiagnostic("reconciliation_fetch_error", {
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
      streamContextRef,
      streamEpochRef,
    ],
  );

  const reconcileActiveConversation = useCallback(
    async (): Promise<ReconcileActiveConversationResult> => {
      const empty: ReconcileActiveConversationResult = {
        changed: false,
        messagesAdded: 0,
        assistantProgress: false,
      };
      const ctx = streamContextRef.current;
      if (!ctx) return empty;

      // Snapshot the turn identity before the async fetch so the
      // POLL_RECONCILED dispatch is scoped to THIS turn. If the user
      // starts a new send while the fetch is in-flight, the turnId guard
      // in the store prevents stale reconciliation from idling it.
      const snapshotTurnId = useTurnStore.getState().activeTurnId;
      const snapshotEpoch = streamEpochRef.current;

      try {
        const serverMessages = await fetchConversationMessages(
          ctx.assistantId,
          ctx.conversationId,
        );
        if (activeConversationIdRef.current !== ctx.conversationId) return empty;
        // If the epoch changed during the fetch (e.g. page went hidden
        // and back), this reconciliation is stale — bail out.
        if (streamEpochRef.current !== snapshotEpoch) return empty;
        recordChatDiagnostic("reconciliation_active_fetch", {
          assistantId: ctx.assistantId,
          conversationId: ctx.conversationId,
          epoch: snapshotEpoch,
          server: summarizeRuntimeMessages(serverMessages),
        });
        return reconcileFetchedMessages(serverMessages, snapshotTurnId);
      } catch {
        // Non-fatal: a fetch failure doesn't prove the turn completed.
        // The .finally() nonce bump reopens SSE to deliver terminal events.
        recordChatDiagnostic("reconciliation_active_fetch_error", {
          assistantId: ctx.assistantId,
          conversationId: ctx.conversationId,
          epoch: snapshotEpoch,
        });
        return empty;
      }
    },
    [
    streamContextRef,
    streamEpochRef,
    activeConversationIdRef,
    reconcileFetchedMessages,
  ]);

  return {
    reconcileFromServer,
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
