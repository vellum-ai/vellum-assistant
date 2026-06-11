import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";

import { useEventStream } from "@/domains/chat/hooks/use-event-stream";

function renderEventStream(params: {
  activeConversationId: string;
  handleStreamEvent?: () => void;
  reconcileActiveConversation?: () => Promise<{
    changed: boolean;
    messagesAdded: number;
    assistantProgress: boolean;
  }>;
  startReconciliationLoop?: (epoch: number) => void;
}) {
  return renderHook(() => {

    useEventStream({
      assistantStateKind: "active",
      assistantId: "asst-1",
      activeConversationId: params.activeConversationId,
      conversationExistsOnServer: true,
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
    });
  });
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useEventStream — sse.opened reconcile triggers", () => {
  test("does not reconcile on the first 'fresh' open (history load owns that)", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    publish("sse.opened", {
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
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "resume",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("reconciles when the bus reopens after a reachability-driven retry", async () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "error",
    });
    // The error path runs reconcile via an async IIFE, so drain
    // microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("reconciles on watchdog reconnect, exactly once", async () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Watchdog used to double-fetch (non-fresh path AND the Sentry-
    // instrumented path each fired their own reconcile). After the
    // restructure they share a single reconcile.
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("ignores opens for a different assistantId", () => {
    const reconcile = mock(async () => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    publish("sse.opened", {
      assistantId: "asst-other",
      cause: "resume",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("does not restart the reconciliation loop with a stale epoch when two watchdog reopens race", async () => {
    // Regression: two close-together cause="watchdog" reopens each
    // launch their own async IIFE. If the older one's reconcile
    // resolves last, it would call startReconciliationLoop(staleEpoch)
    // — and startReconciliationLoop's first action is
    // cancelReconciliation(), which would kill the newer loop and
    // then exit the older loop as stale, leaving NO active loop.
    let resolveFirst!: (value: {
      changed: boolean;
      messagesAdded: number;
      assistantProgress: boolean;
    }) => void;
    let resolveSecond!: (value: {
      changed: boolean;
      messagesAdded: number;
      assistantProgress: boolean;
    }) => void;
    let reconcileCalls = 0;
    const reconcile = mock(() => {
      reconcileCalls += 1;
      return new Promise<{
        changed: boolean;
        messagesAdded: number;
        assistantProgress: boolean;
      }>((resolve) => {
        if (reconcileCalls === 1) {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      });
    });
    const startReconciliationLoop = mock((_epoch: number) => {});
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
      startReconciliationLoop,
    });

    // First reopen — bumps epoch, launches async IIFE.
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
    // Second reopen — bumps epoch again, launches another async IIFE.
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });

    // Drain microtasks so both IIFEs reach the
    // reconcileActiveConversation await and assign the resolvers.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The newer (second) reconcile resolves first.
    resolveSecond({ changed: true, messagesAdded: 1, assistantProgress: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The older (first) reconcile resolves second — its epoch is now
    // stale and the stale-epoch guard must skip startReconciliationLoop.
    resolveFirst({ changed: false, messagesAdded: 0, assistantProgress: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Loop is started exactly once — by the newer epoch only.
    expect(startReconciliationLoop).toHaveBeenCalledTimes(1);
  });
});
