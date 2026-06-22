import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";
import { resetReconnectCursor } from "@/lib/streaming/reconnect-cursor";
import { __resetLocalSeqForTesting } from "@/lib/streaming/local-seq";

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
  resetReconnectCursor();
  __resetLocalSeqForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  resetReconnectCursor();
  __resetLocalSeqForTesting();
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

  test("reconciles non-authoritatively on a warm resume so the freshly streamed tail is kept", async () => {
    /**
     * A warm resume usually replays the daemon's buffered suffix
     * contiguously, with no proven seq gap. Taking the `/messages`
     * snapshot authoritatively here would let the debounced (lagging)
     * snapshot clobber the freshly streamed tail it hasn't persisted yet,
     * leaving a hole in the middle of the response until the server
     * watermark catches up. The authoritative heal is owned by the
     * consumer's seq-gap detector, which only fires on a proven gap.
     */
    // GIVEN a mounted stream that records the reconcile's authoritative arg
    const reconcile = mock(async (_authoritative?: boolean) => ({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });

    // WHEN the bus reopens on a warm resume
    publish("sse.opened", {
      assistantId: "asst-1",
      cause: "resume",
    });

    // THEN the reopen reconcile is invoked without the authoritative flag
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeFalsy();
  });

  test("a proven seq gap on the live stream heals authoritatively", async () => {
    /**
     * When the daemon's replay ring evicts events during a long
     * suspension, the live suffix resumes non-contiguously (the global
     * seq jumps past the next expected value). The consumer's seq-gap
     * detector owns the authoritative heal: it reloads `/messages` and
     * takes the server snapshot wholesale to refill the dropped
     * beginning, so this reconcile must run with the authoritative flag.
     */
    // GIVEN a mounted stream that records the reconcile's authoritative arg
    const reconcile = mock(async (_authoritative?: boolean) => ({
      changed: true,
      messagesAdded: 1,
      assistantProgress: true,
    }));
    renderEventStream({
      activeConversationId: "conv-A",
      reconcileActiveConversation: reconcile as never,
    });
    // AND the global cursor seeded by a first contiguous live event
    publish("sse.event", {
      id: "evt-seed",
      conversationId: "conv-A",
      seq: 5,
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "conv-A",
        text: "a",
      },
    } as AssistantEventEnvelope);

    // WHEN a later event arrives with a seq gap (events were evicted)
    publish("sse.event", {
      id: "evt-gap",
      conversationId: "conv-A",
      seq: 5000,
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "conv-A",
        text: "b",
      },
    } as AssistantEventEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // THEN the gap heal reconcile runs with the authoritative flag set
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(true);
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
