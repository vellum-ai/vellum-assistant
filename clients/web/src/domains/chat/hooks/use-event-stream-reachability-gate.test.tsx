import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { __resetForTesting, subscribe } from "@/lib/event-bus";

import { useEventStream } from "@/domains/chat/hooks/use-event-stream";

function renderEventStream(params: {
  reachabilityPhase: string;
  reachabilityReset?: () => void;
}) {
  return renderHook(
    ({ phase }: { phase: string }) => {
      useEventStream({
        assistantStateKind: "active",
        assistantId: "asst-1",
        activeConversationId: "conv-A",
        conversationExistsOnServer: true,
        handleStreamEvent: () => {},
        reconcileActiveConversation: async () =>
          ({
            changed: false,
            messagesAdded: 0,
            assistantProgress: false,
          }) as never,
        startReconciliationLoop: () => {},
        cancelReconciliation: () => {},
        reachabilityProbe: () => {},
        reachabilityPhase: phase,
        reachabilityReset: params.reachabilityReset ?? (() => {}),
      });
    },
    { initialProps: { phase: params.reachabilityPhase } },
  );
}

function trackRetryRequests(): ReturnType<typeof mock> {
  const handler = mock(() => {});
  subscribe("reachability.retry-requested", handler);
  return handler;
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useEventStream reachability retry gate", () => {
  test("a boot that goes idle to ready requests no retry", () => {
    const retries = trackRetryRequests();
    const { rerender } = renderEventStream({ reachabilityPhase: "idle" });

    rerender({ phase: "ready" });

    expect(retries).not.toHaveBeenCalled();
  });

  test("a mount that already observes ready requests no retry", () => {
    const retries = trackRetryRequests();
    renderEventStream({ reachabilityPhase: "ready" });

    expect(retries).not.toHaveBeenCalled();
  });

  test("a drop and recovery through connecting requests exactly one retry", () => {
    const retries = trackRetryRequests();
    const { rerender } = renderEventStream({ reachabilityPhase: "ready" });

    rerender({ phase: "connecting" });
    rerender({ phase: "ready" });

    expect(retries).toHaveBeenCalledTimes(1);
  });

  test("a recovery through checking requests a retry", () => {
    const retries = trackRetryRequests();
    const { rerender } = renderEventStream({ reachabilityPhase: "checking" });

    rerender({ phase: "ready" });

    expect(retries).toHaveBeenCalledTimes(1);
  });

  test("a late healthy probe that lands on failed requests a retry", () => {
    const retries = trackRetryRequests();
    const { rerender } = renderEventStream({ reachabilityPhase: "failed" });

    rerender({ phase: "ready" });

    expect(retries).toHaveBeenCalledTimes(1);
  });

  test("the 3-per-window budget still exhausts across repeated recoveries", () => {
    const retries = trackRetryRequests();
    const reachabilityReset = mock(() => {});
    const { rerender } = renderEventStream({
      reachabilityPhase: "ready",
      reachabilityReset,
    });

    for (let i = 0; i < 4; i += 1) {
      rerender({ phase: "connecting" });
      rerender({ phase: "ready" });
    }

    expect(retries).toHaveBeenCalledTimes(3);
    expect(reachabilityReset).toHaveBeenCalledTimes(1);
  });
});
