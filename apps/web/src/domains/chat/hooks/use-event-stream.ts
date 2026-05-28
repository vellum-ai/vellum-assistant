/**
 * Conversation-scoped consumer of the bus-owned SSE stream.
 *
 * Subscribes to `bus.sse.event` and routes events whose
 * `conversationId` matches (or is missing on) the active conversation
 * to `handleStreamEvent`. Subscribes to `bus.sse.opened` to bump the
 * conversation epoch and run a reconcile pass on every non-fresh
 * (re)open — `"fresh"` is the very first connection per assistant
 * and is covered by the regular history-load path. On `"watchdog"` /
 * `"error"` causes the reconcile additionally records its result to
 * Sentry so stalled-turn rescues are observable. Subscribes to
 * `bus.sse.closed` to clear any in-flight `isStreaming` flag, drop
 * the matching processing key, and bump reachability so the
 * burst-limited retry below can take over.
 *
 * Reachability retry lives here because the 3-burst limiter is
 * conversation-scoped. On success it publishes
 * `bus.reachability.retry-requested` and the bus bounces its SSE
 * connection; on exhaustion it surfaces a "Connection lost" error so
 * the user can manually retry.
 *
 * Visibility / app-state are owned by `useEventBusInit`. This hook
 * does not register any `visibilitychange` listener of its own.
 */

import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import type { AssistantEvent } from "@/domains/chat/api/event-types";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat-utils";
import {
  bucketMessagesAdded,
  recordChatDiagnostic,
  resolvePlatformTag,
} from "@/domains/chat/utils/diagnostics";
import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncRouter,
} from "@/lib/sync/web-sync-router";

import { endTurn } from "@/stores/turn-coordinator";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import {
  isSending,
  useTurnStore,
} from "@/stores/turn-store";
import type { ChatEventStream } from "@/domains/chat/api/stream";
import { useEventBusStore } from "@/stores/event-bus-store";
import type { UseAssistantReachabilityResult } from "@/assistant/use-assistant-reachability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Params accepted by {@link useEventStream}. */
export interface UseEventStreamParams {
  /** Current assistant lifecycle state kind. */
  assistantStateKind: string;
  /** Resolved assistant ID (null when not yet loaded). */
  assistantId: string | null;
  /** Currently active conversation key. */
  activeConversationId: string | null;
  /** Whether the active conversation has been persisted on the server. */
  conversationExistsOnServer: boolean;

  // Shared refs — owned by caller, read/written by multiple hooks.
  // `streamRef` is a presence-bit: holds a sentinel object while the
  // bus subscription is live for the current conversation context,
  // and is nulled when the subscription tears down. `use-send-message`
  // reads it to decide whether SSE will deliver the response or
  // polling is needed.
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamEpochRef: MutableRefObject<number>;
  reconcileAfterNextStreamOpenRef: MutableRefObject<boolean>;
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationId: string;
  } | null>;

  // Callbacks from useStreamEventHandler / useMessageReconciliation
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void;
  reconcileActiveConversation: () => Promise<ActiveConversationMessagesRefreshResult>;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;

  // Reachability
  reachabilityProbe: UseAssistantReachabilityResult["probe"];
  reachabilityPhase: string;
  reachabilityReset: () => void;

  // Messages
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;

  // Error
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;

  // Sync router ref for post-reconnect reconcile
  syncRouterRef: MutableRefObject<WebSyncRouter | null>;

  // Conversation list invalidated timer ref — cleaned up on unmount
  conversationListInvalidatedTimerRef: MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEventStream({
  assistantStateKind,
  assistantId,
  activeConversationId,
  conversationExistsOnServer,
  streamRef,
  streamEpochRef,
  reconcileAfterNextStreamOpenRef,
  streamContextRef,
  handleStreamEvent,
  reconcileActiveConversation,
  startReconciliationLoop,
  cancelReconciliation,
  reachabilityProbe,
  reachabilityPhase,
  reachabilityReset,
  setMessages,
  setError,
  syncRouterRef,
  conversationListInvalidatedTimerRef,
}: UseEventStreamParams): void {
  // ---- Internal refs (burst-limiter, owned by this hook) ----
  const streamRetryBurstCountRef = useRef(0);
  const streamRetryBurstStartRef = useRef(0);

  // ---- Ref-stabilize unstable callback params ----
  const handleStreamEventRef = useRef(handleStreamEvent);
  handleStreamEventRef.current = handleStreamEvent;

  const reconcileActiveConversationRef = useRef(reconcileActiveConversation);
  reconcileActiveConversationRef.current = reconcileActiveConversation;

  const startReconciliationLoopRef = useRef(startReconciliationLoop);
  startReconciliationLoopRef.current = startReconciliationLoop;

  const reachabilityProbeRef = useRef(reachabilityProbe);
  reachabilityProbeRef.current = reachabilityProbe;

  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;

  const cancelReconciliationRef = useRef(cancelReconciliation);
  cancelReconciliationRef.current = cancelReconciliation;

  const reachabilityResetRef = useRef(reachabilityReset);
  reachabilityResetRef.current = reachabilityReset;

  const reachabilityPhaseRef = useRef(reachabilityPhase);
  const backgroundReachabilityProbeRef = useRef(false);
  useLayoutEffect(() => {
    reachabilityPhaseRef.current = reachabilityPhase;
    if (reachabilityPhase !== "checking") {
      backgroundReachabilityProbeRef.current = false;
    }
  }, [reachabilityPhase]);

  // Track the latest active conversation key in a ref synced during
  // the commit phase. The bus subscriber filters against this ref
  // instead of the closure-captured value so an `assistant_text_delta`
  // published in the gap between a conversation switch and the effect
  // cleanup is rejected as soon as React commits the new active key.
  // Without this, in-flight deltas for the previous conversation can
  // merge into the new conversation's messages.
  //
  // The ref is updated in `useLayoutEffect` (commit phase) rather than
  // during render. Under concurrent React a render can be aborted; a
  // render-phase mutation would leave the ref pointing at a value
  // from an uncommitted render and the filter would reject events
  // for what is still the actually-committed conversation.
  const activeConversationIdLatestRef = useRef(activeConversationId);
  useLayoutEffect(() => {
    activeConversationIdLatestRef.current = activeConversationId;
  }, [activeConversationId]);

  // --------------------------------------------------------------------------
  // Effect 1: Subscribe to the bus-owned SSE for the active conversation.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    if (!conversationExistsOnServer) {
      return;
    }

    const bus = useEventBusStore.getState();
    const capturedAssistantId = assistantId;
    const capturedConversationId = activeConversationId;

    streamContextRef.current = {
      assistantId: capturedAssistantId,
      conversationId: capturedConversationId,
    };
    // `use-send-message.ts` reads `streamRef.current` as a presence bit
    // to decide whether SSE will deliver the response. We write a
    // sentinel whose `cancel()` is a no-op — the real teardown is the
    // bus unsubscribe in the cleanup function below.
    const presence: ChatEventStream = { cancel: () => {} };
    streamRef.current = presence;

    const unsubEvent = bus.subscribe("sse.event", (event) => {
      const eventConversationId = (event as { conversationId?: string })
        .conversationId;
      // Two-stage filter to prevent cross-conversation event leakage.
      // The bus opens a single unfiltered SSE connection, so every
      // event for every conversation flows through this subscriber.
      //
      // 1. Global events (`sync_changed`, `home_feed_updated`, etc.)
      //    are not tied to a conversation — always pass them through.
      // 2. Conversation-scoped events must have an explicit
      //    `conversationId` matching the current active conversation.
      //    Events whose conversationId is missing or mismatched are
      //    rejected: a missing id is treated as "unknown
      //    conversation" rather than "broadcast", because under the
      //    bus-owned unfiltered SSE there is no per-conversation
      //    subscription URL to fall back to for routing.
      if (!isConversationScopedStreamEvent(event)) {
        handleStreamEventRef.current(event, streamEpochRef.current);
        return;
      }
      if (
        eventConversationId === undefined ||
        eventConversationId !== activeConversationIdLatestRef.current
      ) {
        recordChatDiagnostic("sse_event_wrong_conversation_filtered", {
          eventConversationId,
          activeConversationId: activeConversationIdLatestRef.current,
          eventType: event.type,
          reason: eventConversationId === undefined ? "missing" : "mismatch",
        });
        return;
      }
      handleStreamEventRef.current(event, streamEpochRef.current);
    });

    return () => {
      unsubEvent();
      streamEpochRef.current += 1;
      if (streamRef.current === presence) {
        streamRef.current = null;
      }
      if (
        streamContextRef.current?.assistantId === capturedAssistantId &&
        streamContextRef.current.conversationId === capturedConversationId
      ) {
        streamContextRef.current = null;
      }
    };
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
    streamRef,
    streamEpochRef,
    streamContextRef,
  ]);

  // --------------------------------------------------------------------------
  // Effect 2: React to bus-owned SSE (re)opens.
  //
  // Bumps the conversation epoch so any in-flight reconcile from the
  // previous attempt is ignored. Runs the pending-reconcile flag set
  // by app.resume, and the watchdog-recovery reconcile that today
  // lives in `subscribeChatEvents`' `onReconnect` callback.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    const capturedAssistantId = assistantId;
    const capturedConversationId = activeConversationId;

    const unsub = useEventBusStore
      .getState()
      .subscribe("sse.opened", ({ assistantId: openedFor, cause }) => {
        if (openedFor !== capturedAssistantId) return;
        const epoch = ++streamEpochRef.current;
        recordChatDiagnostic("sse_stream_opened", {
          assistantId: capturedAssistantId,
          conversationId: capturedConversationId,
          epoch,
          cause,
        });
        if (cause === "fresh") {
          // First open per assistant — the regular history-load path
          // that ran when the conversation was mounted owns the
          // initial fetch, so we don't reconcile here.
          return;
        }
        reconcileAfterNextStreamOpenRef.current = false;
        // `"watchdog"` and `"error"` indicate a transport-level
        // recovery the daemon may have rescued via its own reconnect
        // path. Prefer the sync router's `dispatchReconnect()` result
        // — it returns the active conversation's refreshed messages
        // in the same roundtrip — and fall back to the standalone
        // reconcile only when the sync router didn't return them.
        // The Sentry rescue diagnostic uses the same reconcile result
        // so it accurately reflects what the user saw recover.
        // Other non-fresh causes (`"resume"`) only need the standalone
        // reconcile.
        if (cause === "watchdog" || cause === "error") {
          void (async () => {
            recordChatDiagnostic("sse_stream_reconnect", {
              assistantId: capturedAssistantId,
              conversationId: capturedConversationId,
              epoch,
              cause,
            });
            const startedAt = Date.now();
            const syncReconnectResult =
              await syncRouterRef.current?.dispatchReconnect();
            const reconcileResult =
              syncReconnectResult?.activeConversationMessages ??
              (await reconcileActiveConversationRef.current());
            // Stale-epoch guard: two close-together reopens can race —
            // if a newer sse.opened has bumped the epoch while we were
            // awaiting, this completion is for a superseded epoch and
            // must not touch the reconciliation loop or emit Sentry
            // diagnostics that would mislead the rescue metric.
            // Without this, calling startReconciliationLoop(staleEpoch)
            // would cancel the newer loop and then exit as stale,
            // leaving no active loop running.
            if (epoch !== streamEpochRef.current) {
              recordChatDiagnostic("sse_post_reconnect_stale", {
                assistantId: capturedAssistantId,
                conversationId: capturedConversationId,
                epoch,
                currentEpoch: streamEpochRef.current,
                cause,
              });
              return;
            }
            startReconciliationLoopRef.current(epoch);
            if (cause !== "watchdog") return;
            const latencyMs = Date.now() - startedAt;
            recordChatDiagnostic("sse_post_watchdog_reconcile_result", {
              assistantId: capturedAssistantId,
              conversationId: capturedConversationId,
              epoch,
              latencyMs,
              changed: reconcileResult.changed,
              messagesAdded: reconcileResult.messagesAdded,
              assistantProgress: reconcileResult.assistantProgress,
            });
            Sentry.addBreadcrumb({
              category: "sse.watchdog",
              level: "info",
              message: "post_watchdog_reconcile_result",
              data: {
                latencyMs,
                changed: reconcileResult.changed,
                messagesAdded: reconcileResult.messagesAdded,
                assistantProgress: reconcileResult.assistantProgress,
              },
            });
            Sentry.captureMessage("sse_post_watchdog_reconcile_result", {
              level: "info",
              tags: {
                context: "sse_watchdog",
                platform: resolvePlatformTag(),
                assistantProgress: String(reconcileResult.assistantProgress),
                rescued: String(reconcileResult.messagesAdded > 0),
                messagesAddedBucket: bucketMessagesAdded(
                  reconcileResult.messagesAdded,
                ),
              },
              extra: {
                latencyMs,
                messagesAdded: reconcileResult.messagesAdded,
                changed: reconcileResult.changed,
                assistantProgress: reconcileResult.assistantProgress,
                conversationId: capturedConversationId,
                epoch,
              },
            });
          })();
          return;
        }
        void reconcileActiveConversationRef.current();
        startReconciliationLoopRef.current(epoch);
      });

    return () => unsub();
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    streamEpochRef,
    reconcileAfterNextStreamOpenRef,
    syncRouterRef,
  ]);

  // --------------------------------------------------------------------------
  // Effect 3: React to bus-owned SSE close events.
  //
  // The bus emits `sse.closed` on transport errors. We clear any
  // in-flight assistant streaming flag so the composer doesn't sit in
  // "thinking" forever, drop the matching processing key so the
  // sidebar's indicator clears, and bounce reachability so the
  // burst-limiter in effect 5 can kick a retry.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    const capturedAssistantId = assistantId;
    const capturedConversationId = activeConversationId;

    const unsub = useEventBusStore
      .getState()
      .subscribe("sse.closed", ({ reason }) => {
        const hadActiveTurn = isSending(useTurnStore.getState());
        recordChatDiagnostic("sse_stream_error", {
          assistantId: capturedAssistantId,
          conversationId: capturedConversationId,
          epoch: streamEpochRef.current,
          messageLength: reason.length,
        });
        endTurn({
          conversationId: streamContextRef.current?.conversationId,
          reason: "session_error",
        });
        // Idle SSE drops should reopen the stream without interrupting the
        // user; active turns still surface the reconnect state immediately.
        if (hadActiveTurn) {
          reachabilityProbeRef.current({ showConnectingImmediately: true });
        } else {
          backgroundReachabilityProbeRef.current = true;
          reachabilityProbeRef.current({ mode: "background" });
        }
        setMessagesRef.current((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
          }
          return prev;
        });
      });

    return () => unsub();
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    streamEpochRef,
    streamContextRef,
  ]);

  // --------------------------------------------------------------------------
  // Effect 4: Upgrade hidden background checks once a turn becomes active.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }

    let wasSending = isSending(useTurnStore.getState());
    return useTurnStore.subscribe((state) => {
      const nowSending = isSending(state);
      if (
        !wasSending &&
        nowSending &&
        (backgroundReachabilityProbeRef.current ||
          reachabilityPhaseRef.current === "checking")
      ) {
        backgroundReachabilityProbeRef.current = false;
        reachabilityProbeRef.current({ showConnectingImmediately: true });
      }
      wasSending = nowSending;
    });
  }, [assistantStateKind, assistantId, activeConversationId]);

  // --------------------------------------------------------------------------
  // Effect 5: Schedule a post-resume reconcile.
  //
  // The bus tears down + reopens its SSE around app.resume; we listen
  // here so the next `sse.opened` runs the reconcile pass for the
  // active conversation. Effect 2's `reconcileAfterNextStreamOpenRef`
  // gate is the rendezvous point.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    const unsub = useEventBusStore.getState().subscribe("app.resume", () => {
      reconcileAfterNextStreamOpenRef.current = true;
    });
    return () => unsub();
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    reconcileAfterNextStreamOpenRef,
  ]);

  // --------------------------------------------------------------------------
  // Effect 6: Reachability retry — request a bus-level SSE bounce
  // when the reachability probe flips back to "ready" or a background
  // probe exhausts its window and needs the bus to keep retrying.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (reachabilityPhase !== "ready" && reachabilityPhase !== "retrying") {
      return;
    }
    const now = Date.now();
    const STREAM_RETRY_BURST_WINDOW_MS = 10_000;
    const STREAM_RETRY_BURST_LIMIT = 3;
    if (
      now - streamRetryBurstStartRef.current >
      STREAM_RETRY_BURST_WINDOW_MS
    ) {
      streamRetryBurstStartRef.current = now;
      streamRetryBurstCountRef.current = 0;
    }
    streamRetryBurstCountRef.current += 1;
    if (streamRetryBurstCountRef.current > STREAM_RETRY_BURST_LIMIT) {
      setErrorRef.current({ message: "Connection lost. Please try again." });
      reachabilityResetRef.current();
      return;
    }
    if (reachabilityPhase === "ready") {
      useTurnStore.getState().resetTurn();
      setErrorRef.current(null);
    }
    reconcileAfterNextStreamOpenRef.current = true;
    useEventBusStore
      .getState()
      .publish("reachability.retry-requested", {});
    if (reachabilityPhase === "retrying") {
      reachabilityResetRef.current();
    }
  }, [reachabilityPhase, reconcileAfterNextStreamOpenRef]);

  // --------------------------------------------------------------------------
  // Effect 7: Unmount cleanup.
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cancelReconciliationRef.current();
      if (conversationListInvalidatedTimerRef.current) {
        clearTimeout(conversationListInvalidatedTimerRef.current);
        conversationListInvalidatedTimerRef.current = null;
      }
    };
  }, [conversationListInvalidatedTimerRef]);
}
