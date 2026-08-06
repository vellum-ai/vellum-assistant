import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { __resetForTesting, subscribe } from "@/lib/event-bus";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import { useTurnStore } from "@/domains/chat/turn-store";

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

function seedStaleConnectionLostUi(): void {
  useChatSessionStore.getState().setError({ message: "Connection lost." });
  useTurnStore.setState({ phase: "thinking", activeTurnId: null });
}

beforeEach(() => {
  __resetForTesting();
  useChatSessionStore.getState().setError(null);
  useTurnStore.getState().resetTurn();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useChatSessionStore.getState().setError(null);
  useTurnStore.getState().resetTurn();
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

  test("a boot confirmation still clears the stale connection error", () => {
    const retries = trackRetryRequests();
    seedStaleConnectionLostUi();
    const { rerender } = renderEventStream({ reachabilityPhase: "idle" });

    rerender({ phase: "ready" });

    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useTurnStore.getState().phase).toBe("idle");
    expect(retries).not.toHaveBeenCalled();
  });

  test("a remount onto an already-ready assistant clears the stale error", () => {
    const retries = trackRetryRequests();
    seedStaleConnectionLostUi();

    renderEventStream({ reachabilityPhase: "ready" });

    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useTurnStore.getState().phase).toBe("idle");
    expect(retries).not.toHaveBeenCalled();
  });

  test("a confirmation leaves a live turn alone", () => {
    seedStaleConnectionLostUi();
    useTurnStore.setState({ phase: "streaming", activeTurnId: "turn-1" });

    const { rerender } = renderEventStream({ reachabilityPhase: "idle" });
    rerender({ phase: "ready" });

    expect(useTurnStore.getState().phase).toBe("streaming");
    expect(useTurnStore.getState().activeTurnId).toBe("turn-1");
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  test("confirmations spend none of the retry budget", () => {
    const retries = trackRetryRequests();
    const reachabilityReset = mock(() => {});
    const { rerender } = renderEventStream({
      reachabilityPhase: "idle",
      reachabilityReset,
    });

    // Two boot/remount confirmations, then three genuine recoveries.
    rerender({ phase: "ready" });
    rerender({ phase: "idle" });
    rerender({ phase: "ready" });
    for (let i = 0; i < 3; i += 1) {
      rerender({ phase: "connecting" });
      rerender({ phase: "ready" });
    }

    expect(retries).toHaveBeenCalledTimes(3);
    expect(reachabilityReset).not.toHaveBeenCalled();
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
