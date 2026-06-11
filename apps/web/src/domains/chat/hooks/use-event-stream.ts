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
 * Bus subscriptions use `useBusSubscription` per EVENT_BUS.md. The
 * stream-context lifecycle (setup / teardown of the stream-store
 * sentinel) remains in a plain `useEffect` since it is resource
 * management, not event handling.
 *
 * Visibility / app-state are owned by `useEventBusInit`. This hook
 * does not register any `visibilitychange` listener of its own.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import type { EventStream } from "@/lib/streaming/stream-transport";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";
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
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;

  // Reachability
  reachabilityProbe: UseAssistantReachabilityResult["probe"];
  reachabilityPhase: string;
  reachabilityReset: () => void;
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
}: UseEventStreamParams): void {
  // ---- Ref-stabilize unstable callback params ----
  //
  // Updated in `useLayoutEffect` (commit phase) so refs only ever
  // hold values from committed renders — matching the pattern used
  // by `useBusSubscription` and `activeConversationIdLatestRef`.
  // Under concurrent React a render can be aborted; a render-phase
  // mutation would leave the ref pointing at an uncommitted value.
  // See https://react.dev/reference/react/useRef#caveats
  const handleStreamEventRef = useRef(handleStreamEvent);
  const reconcileActiveConversationRef = useRef(reconcileActiveConversation);
  const startReconciliationLoopRef = useRef(startReconciliationLoop);
  const reachabilityProbeRef = useRef(reachabilityProbe);
  const cancelReconciliationRef = useRef(cancelReconciliation);
  const reachabilityResetRef = useRef(reachabilityReset);
  useLayoutEffect(() => {
    handleStreamEventRef.current = handleStreamEvent;
    reconcileActiveConversationRef.current = reconcileActiveConversation;
    startReconciliationLoopRef.current = startReconciliationLoop;
    reachabilityProbeRef.current = reachabilityProbe;
    cancelReconciliationRef.current = cancelReconciliation;
    reachabilityResetRef.current = reachabilityReset;
  });

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
  /* eslint-disable react-hooks/refs -- lazy-init (runs once) */
  if (burstLimiterRef.current == null) {
    burstLimiterRef.current = createReachabilityBurstLimiter({
      onReady: () => useTurnStore.getState().resetTurn(),
      onClearError: () => useChatSessionStore.getState().setError(null),
      onExhausted: (err) => useChatSessionStore.getState().setError(err),
      onReset: () => reachabilityResetRef.current(),
    });
  }
  /* eslint-enable react-hooks/refs */

  // --------------------------------------------------------------------------
  // Stream context lifecycle — setup / teardown of the stream-store
  // sentinel. Not a bus subscription; resource management that must
  // track the active conversation's identity.
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
    // in `useBusSubscription`.
    const presence: EventStream = { cancel: () => {} };
    ss.setStream(presence);

    return () => {
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
  // SSE event consumer — recreated per conversation so internal seq-
  // tracking state resets on switch. Reads callback params from stable
  // refs at call time, so the factory deps are only the identity keys.
  // --------------------------------------------------------------------------
  const consumer = useMemo(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId ||
      !conversationExistsOnServer
    ) {
      return null;
    }
    // Refs read inside closures that run at event-dispatch time, not during render.
    // eslint-disable-next-line react-hooks/refs
    return createSseEventConsumer({
      activeConversationIdRef: activeConversationIdLatestRef,
      handleStreamEvent: (event, epoch) =>
        handleStreamEventRef.current(event, epoch),
      reconcileActive: () => reconcileActiveConversationRef.current(),
    });
  }, [
    assistantStateKind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
  ]);

  // --------------------------------------------------------------------------
  // Post-reconnect reconcile handler — recreated per conversation so
  // diagnostics capture the correct assistant/conversation pair and the
  // handler's captured-id filter stays current.
  // --------------------------------------------------------------------------
  const reconcileHandler = useMemo(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return null;
    }
    // Refs read inside closures that run at event-dispatch time, not during render.
    // eslint-disable-next-line react-hooks/refs
    return createReconcileOnReopen({
      assistantId,
      conversationId: activeConversationId,
      reconcileActive: () => reconcileActiveConversationRef.current(),
      startReconciliationLoop: (epoch) =>
        startReconciliationLoopRef.current(epoch),
    });
  }, [assistantStateKind, assistantId, activeConversationId]);

  // --------------------------------------------------------------------------
  // Bus subscriptions — per EVENT_BUS.md, React code uses
  // `useBusSubscription` instead of raw `subscribe` inside useEffect.
  // The helper auto-stabilizes the handler ref (useLayoutEffect) so
  // inline closures are safe and subscriptions are never torn down /
  // re-registered on re-render.
  // --------------------------------------------------------------------------

  useBusSubscription("sse.event", (envelope) => {
    consumer?.handleSseEvent(envelope);
  });

  useBusSubscription("sse.opened", (payload) => {
    reconcileHandler?.handleSseOpened(payload);
  });

  useBusSubscription("sse.closed", ({ reason }) => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    const hadActiveTurn = isSending(useTurnStore.getState().phase);
    const streamState = useStreamStore.getState();
    recordLifecycleDiagnostic("sse_stream_error", {
      assistantId,
      conversationId: activeConversationId,
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

  // --------------------------------------------------------------------------
  // Upgrade hidden background checks once a turn becomes active.
  // (Zustand store subscription, not a bus event.)
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }

    let wasSending = isSending(useTurnStore.getState().phase);
    return useTurnStore.subscribe((state) => {
      const nowSending = isSending(state.phase);
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
  // Reachability retry — drive the burst-limiter from the probe's
  // phase. The limiter publishes `reachability.retry-requested` on
  // success so the bus bounces its SSE; `reconcileOnReopen` runs the
  // post-reconnect reconcile on the resulting `sse.opened`.
  // --------------------------------------------------------------------------
  useEffect(() => {
    burstLimiterRef.current!.handleReachabilityPhase(reachabilityPhase);
  }, [reachabilityPhase]);

  // --------------------------------------------------------------------------
  // Unmount cleanup.
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cancelReconciliationRef.current();
    };
  }, []);
}
