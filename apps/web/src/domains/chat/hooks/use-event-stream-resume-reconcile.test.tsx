import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";

import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

import { useEventStream } from "@/domains/chat/hooks/use-event-stream.js";

type StreamContext = { assistantId: string; conversationKey: string };

function renderEventStream(params: {
  activeConversationKey: string;
  handleStreamEvent?: () => void;
  reconcileActiveConversation?: () => Promise<{
    changed: boolean;
    messagesAdded: number;
    assistantProgress: boolean;
  }>;
  startReconciliationLoop?: (epoch: number) => void;
}) {
  return renderHook(() => {
    const streamRef = useRef<ChatEventStream | null>(null);
    const streamEpochRef = useRef(0);
    const reconcileAfterNextStreamOpenRef = useRef(false);
    const streamContextRef = useRef<StreamContext | null>(null);
    const syncRouterRef = useRef(null) as MutableRefObject<null> as never;
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEventStream({
      assistantStateKind: "active",
      assistantId: "asst-1",
      activeConversationKey: params.activeConversationKey,
      conversationExistsOnServer: true,
      streamRef,
      streamEpochRef,
      reconcileAfterNextStreamOpenRef,
      streamContextRef,
      handleStreamEvent: params.handleStreamEvent ?? (() => {}),
      reconcileActiveConversation:
        params.reconcileActiveConversation ??
        (async () =>
          ({
            changed: false,
            messagesAdded: 0,
            assistantProgress: false,
          }) as never),
      startReconciliationLoop: params.startReconciliationLoop ?? (() => {}),
      cancelReconciliation: () => {},
      reachabilityProbe: () => {},
      reachabilityPhase: "ready",
      reachabilityReset: () => {},
      setMessages: () => {},
      setError: () => {},
      syncRouterRef,
      conversationListInvalidatedTimerRef: timerRef,
    });
  });
}

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useEventStream — sse.opened reconcile triggers", () => {
  test("does not reconcile on the first 'fresh' open (history load owns that)", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationKey: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    useEventBusStore.getState().publish("sse.opened", {
      assistantId: "asst-1",
      cause: "fresh",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("reconciles when the bus reopens after a resume", async () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationKey: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    useEventBusStore.getState().publish("sse.opened", {
      assistantId: "asst-1",
      cause: "resume",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("reconciles when the bus reopens after a reachability-driven retry", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationKey: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    useEventBusStore.getState().publish("sse.opened", {
      assistantId: "asst-1",
      cause: "error",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("reconciles on watchdog reconnect", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationKey: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    useEventBusStore.getState().publish("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
    // The watchdog path calls reconcile twice: once via the
    // non-fresh shortcut and once via the Sentry-instrumented
    // dispatch. Both go through the same callback ref.
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("ignores opens for a different assistantId", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationKey: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    useEventBusStore.getState().publish("sse.opened", {
      assistantId: "asst-other",
      cause: "resume",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
