/**
 * Conversation-scoped wiring for the bus-owned SSE stream.
 *
 * React adapter that connects four concerns:
 *
 * 1. `sse.event` → `sseEventConsumer` (cross-conversation filter,
 *    seq-gap detection, dispatch into the chat domain).
 * 2. `sse.opened` → `reconcileOnReopen` (post-reconnect reconcile,
 *    epoch bump, watchdog rescue telemetry).
 * 3. `sse.closed` → end the in-flight turn, kick the reachability
 *    probe so the burst-limiter below can take over.
 * 4. `reachabilityPhase` → `reachabilityBurstLimiter` (3-burst /
 *    10s window retry budget; on success publishes
 *    `reachability.retry-requested` so the bus bounces its SSE).
 *
 * Visibility / app-state are owned by `useEventBusInit`. This hook
 * does not register any `visibilitychange` listener of its own.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import {
  createReachabilityBurstLimiter,
  type ReachabilityBurstLimiter,
} from "@/domains/chat/streaming/reachability-burst-limiter";
import { createReconcileOnReopen } from "@/domains/chat/streaming/reconcile-on-reopen";
import { createSseEventConsumer } from "@/domains/chat/streaming/sse-event-consumer";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { subscribe } from "@/lib/event-bus";
import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import type { ChatEventStream } from "@/lib/streaming/stream-transport";
import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncReconnectResult,
} from "@/lib/sync/web-sync-router";
import type { AssistantEvent } from "@/types/event-types";
import type { UseAssistantReachabilityResult } from "@/assistant/use-assistant-reachability";

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

  // Callbacks from useStreamEventHandler / useMessageReconciliation
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void;
  reconcileActiveConversation: () => Promise<ActiveConversationMessagesRefreshResult>;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;

  // Reachability
  reachabilityProbe: UseAssistantReachabilityResult["probe"];
  reachabilityPhase: string;
  reachabilityReset: () => void;

  // Sync router dispatch for post-reconnect reconcile
  dispatchReconnect: () => Promise<WebSyncReconnectResult | undefined>;

  /** Cancel any pending debounced conversation list refetch on unmount. */
  cancelScheduledRefetch: () => void;
}

export function useEventStream({
  assistantStateKind,
  assistantId,
  activeConversationId,
  conversationExistsOnServer,
  handleStreamEvent,
  reconcileActiveConversation,
  startReconciliationLoop,
  cancelReconciliation,
  reachabilityProbe,
  reachabilityPhase,
  reachabilityReset,
  dispatchReconnect,
  cancelScheduledRefetch,
}: UseEventStreamParams): void {
  // ---- Ref-stabilize unstable callback params ----
  const handleStreamEventRef = useRef(handleStreamEvent);
  handleStreamEventRef.current = handleStreamEvent;

  const reconcileActiveConversationRef = useRef(reconcileActiveConversation);
  reconcileActiveConversationRef.current = reconcileActiveConversation;

  const startReconciliationLoopRef = useRef(startReconciliationLoop);
  startReconciliationLoopRef.current = startReconciliationLoop;

  const reachabilityProbeRef = useRef(reachabilityProbe);
  reachabilityProbeRef.current = reachabilityProbe;

  const cancelReconciliationRef = useRef(cancelReconciliation);
  cancelReconciliationRef.current = cancelReconciliation;

  const reachabilityResetRef = useRef(reachabilityReset);
  reachabilityResetRef.current = reachabilityReset;

  const dispatchReconnectRef = useRef(dispatchReconnect);
  dispatchReconnectRef.current = dispatchReconnect;

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

  // Stable burst-limiter — its internal counter / window state must
  // survive `reachabilityPhase` ticks. Lazy-init pattern via `useRef`:
  // a fresh limiter on every render would reset the burst counter and
  // let the user retry forever. `useMemo` would also work but is
  // misleading here — there's no dep that could legitimately change.
  const burstLimiterRef = useRef<ReachabilityBurstLimiter | null>(null);
  if (!burstLimiterRef.current) {
    burstLimiterRef.current = createReachabilityBurstLimiter({
      onReady: () => useTurnStore.getState().resetTurn(),
      onClearError: () => useChatSessionStore.getState().setError(null),
      onExhausted: (err) => useChatSessionStore.getState().setError(err),
      onReset: () => reachabilityResetRef.current(),
    });
  }

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

    const capturedAssistantId = assistantId;
    const capturedConversationId = activeConversationId;

    const ss = useStreamStore.getState();
    ss.setStreamContext({
      assistantId: capturedAssistantId,
      conversationId: capturedConversationId,
    });
    // `use-send-message.ts` reads `stream` as a presence bit to decide
    // whether SSE will deliver the response. We write a sentinel whose
    // `cancel()` is a no-op — the real teardown is the bus unsubscribe
    // in the cleanup function below.
    const presence: ChatEventStream = { cancel: () => {} };
    ss.setStream(presence);

    const consumer = createSseEventConsumer({
      activeConversationIdRef: activeConversationIdLatestRef,
      handleStreamEvent: (event, epoch) =>
        handleStreamEventRef.current(event, epoch),
      reconcileActive: () => reconcileActiveConversationRef.current(),
    });

    const unsubEvent = subscribe("sse.event", (envelope) =>
      consumer.handleSseEvent(envelope),
    );

    // clientSeq resets to 1 on each new SSE subscription (fresh
    // server-side counter map). Reset the consumer's seq tracking on
    // reconnect so the first post-reconnect event re-seeds the cursor
    // instead of triggering a false generation reset.
    const unsubOpened = subscribe("sse.opened", () =>
      consumer.notifyReconnect(),
    );

    return () => {
      unsubEvent();
      unsubOpened();
      useStreamStore.getState().bumpEpoch();
      // Clear stream/context only if they still belong to this
      // subscription — a newer subscription may have already replaced
      // them. Uses identity check (stream) and value check (context),
      // matching the original ref-based ownership checks.
      const s = useStreamStore.getState();
      if (s.stream === presence) {
        s.setStream(null);
      }
      const ctx = s.streamContext;
      if (
        ctx?.assistantId === capturedAssistantId &&
        ctx.conversationId === capturedConversationId
      ) {
        s.setStreamContext(null);
      }
    };
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
  ]);

  // --------------------------------------------------------------------------
  // Effect 2: React to bus-owned SSE (re)opens — runs the post-reconnect
  // reconcile pass via the `reconcileOnReopen` module.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }

    const handler = createReconcileOnReopen({
      assistantId,
      conversationId: activeConversationId,
      reconcileActive: () => reconcileActiveConversationRef.current(),
      startReconciliationLoop: (epoch) =>
        startReconciliationLoopRef.current(epoch),
      dispatchReconnect: dispatchReconnectRef.current,
    });

    return subscribe("sse.opened", (payload) =>
      handler.handleSseOpened(payload),
    );
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
  ]);

  // --------------------------------------------------------------------------
  // Effect 3: React to bus-owned SSE close events.
  //
  // The bus emits `sse.closed` on transport errors. We clear any
  // in-flight assistant streaming flag so the composer doesn't sit in
  // "thinking" forever, drop the matching processing key so the
  // sidebar's indicator clears, and bounce reachability so the
  // burst-limiter below can kick a retry.
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

    return subscribe("sse.closed", ({ reason }) => {
      const hadActiveTurn = isSending(useTurnStore.getState());
      const streamState = useStreamStore.getState();
      recordLifecycleDiagnostic("sse_stream_error", {
        assistantId: capturedAssistantId,
        conversationId: capturedConversationId,
        epoch: streamState.streamEpoch,
        messageLength: reason.length,
      });
      endTurn({
        conversationId: streamState.streamContext?.conversationId,
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
    });
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
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
  // Effect 5: Reachability retry — drive the burst-limiter from the
  // probe's phase. The limiter publishes `reachability.retry-requested`
  // on success so the bus bounces its SSE; `reconcileOnReopen` runs
  // the post-reconnect reconcile on the resulting `sse.opened`.
  // --------------------------------------------------------------------------
  useEffect(() => {
    burstLimiterRef.current!.handleReachabilityPhase(reachabilityPhase);
  }, [reachabilityPhase]);

  // --------------------------------------------------------------------------
  // Effect 6: Unmount cleanup.
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cancelReconciliationRef.current();
      cancelScheduledRefetch();
    };
  }, [cancelScheduledRefetch]);
}
