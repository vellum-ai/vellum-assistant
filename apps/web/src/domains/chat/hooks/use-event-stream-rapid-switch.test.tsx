import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import type { AssistantEvent } from "@/types/event-types";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";

type CapturedEvent = {
  event: AssistantEvent;
  epoch: number;
  /** Snapshot of activeConversationId at the moment the handler ran. */
  activeKeyAtHandlerTime: string;
};

function renderEventStreamWithCapture(
  initialKey: string,
  observeKeyRef: { current: string },
): {
  rerender: (props: { key: string }) => void;
  unmount: () => void;
  captured: CapturedEvent[];
} {
  const captured: CapturedEvent[] = [];
  const result = renderHook(
    ({ key }: { key: string }) => {
      observeKeyRef.current = key;

      useEventStream({
        assistantStateKind: "active",
        assistantId: "asst-1",
        activeConversationId: key,
        conversationExistsOnServer: true,
        handleStreamEvent: (event, epoch) => {
          captured.push({
            event,
            epoch,
            activeKeyAtHandlerTime: observeKeyRef.current,
          });
        },
        reconcileActiveConversation: async () =>
          ({ changed: false, messagesAdded: 0, assistantProgress: false }) as never,
        startReconciliationLoop: () => {},
        cancelReconciliation: () => {},
        reachabilityProbe: () => {},
        reachabilityPhase: "ready",
        reachabilityReset: () => {},
      });
    },
    { initialProps: { key: initialKey } },
  );
  return {
    rerender: (props) => result.rerender(props),
    unmount: result.unmount,
    captured,
  };
}

function publishDelta(conversationId: string): void {
  publish("sse.event", {
    id: `evt-${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    emittedAt: new Date().toISOString(),
    message: {
      type: "assistant_text_delta",
      conversationId,
      text: `delta-${Math.random().toString(36).slice(2, 6)}`,
    },
  } as AssistantEventEnvelope);
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useEventStream — rapid conversation switch stress", () => {
  test("A→B→C→A within a single tick: no event for an inactive conversation reaches the handler", () => {
    const observeKey = { current: "" };
    const { rerender, captured } = renderEventStreamWithCapture(
      "conv-A",
      observeKey,
    );

    // Interleave conversation switches with deltas for various keys.
    publishDelta("conv-A");
    publishDelta("conv-B");
    act(() => {
      rerender({ key: "conv-B" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");
    publishDelta("conv-C");
    act(() => {
      rerender({ key: "conv-C" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");
    publishDelta("conv-C");
    act(() => {
      rerender({ key: "conv-A" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");

    // Every captured event MUST be for the conversation that was
    // active at the time the handler ran. The wrong-chat regression
    // is exactly the case where this assertion fails: an in-flight
    // delta for the previous conversation reaching the handler after
    // React commits the switch.
    for (const { event, activeKeyAtHandlerTime } of captured) {
      const eventConversationId = (event as { conversationId?: string })
        .conversationId;
      expect(eventConversationId).toBe(activeKeyAtHandlerTime);
    }
  });

  test("delta published immediately after a commit but before any further event-loop tick is rejected if it's for the previous conversation", () => {
    // The bus subscription is stable (never torn down / re-registered
    // between conversations). After React commits a new active key,
    // `activeConversationIdLatestRef` is updated in `useLayoutEffect`
    // (commit phase). A delta for the previous conversation that
    // arrives after commit is rejected because the SSE consumer's
    // filter reads the LATEST ref, which already points to the new
    // key.
    const observeKey = { current: "" };
    const { rerender, captured } = renderEventStreamWithCapture(
      "conv-A",
      observeKey,
    );
    publishDelta("conv-A");
    expect(captured).toHaveLength(1);
    act(() => {
      rerender({ key: "conv-B" });
    });
    // rerender + act flushed: commit ran (`activeConversationIdLatestRef`
    // is now "conv-B"). The bus subscription is unchanged — only the
    // ref-based filter updated. Now a late "conv-A" delta arrives.
    publishDelta("conv-A");
    // The filter must reject it.
    expect(captured).toHaveLength(1);
  });

  test("the handler is never called with an event whose key does not match the latest active key", () => {
    const observeKey = { current: "" };
    const { rerender, captured } = renderEventStreamWithCapture(
      "conv-A",
      observeKey,
    );
    // Switch to B, then immediately publish an A delta. Then switch
    // to C and publish an A delta and a B delta. Then back to A and
    // publish all three keys.
    act(() => {
      rerender({ key: "conv-B" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");
    act(() => {
      rerender({ key: "conv-C" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");
    publishDelta("conv-C");
    act(() => {
      rerender({ key: "conv-A" });
    });
    publishDelta("conv-A");
    publishDelta("conv-B");
    publishDelta("conv-C");

    // Total expected captures: 1 (B while on B) + 1 (C while on C) +
    // 1 (A while on A) = 3.
    expect(captured).toHaveLength(3);
    expect(
      captured.map(
        (c) => (c.event as { conversationId?: string }).conversationId,
      ),
    ).toEqual(["conv-B", "conv-C", "conv-A"]);
  });

  test("burst of 50 deltas with interleaved conversation switches: every captured delta matches the active key", () => {
    const observeKey = { current: "" };
    const keys = ["conv-A", "conv-B", "conv-C", "conv-D"];
    const { rerender, captured } = renderEventStreamWithCapture(
      keys[0]!,
      observeKey,
    );
    let cycle = 0;
    for (let i = 0; i < 50; i++) {
      // Publish a delta for a random key (often NOT the active one).
      publishDelta(keys[i % keys.length]!);
      if (i % 5 === 0) {
        cycle = (cycle + 1) % keys.length;
        act(() => {
          rerender({ key: keys[cycle]! });
        });
      }
    }
    for (const { event, activeKeyAtHandlerTime } of captured) {
      const eventConversationId = (event as { conversationId?: string })
        .conversationId;
      expect(eventConversationId).toBe(activeKeyAtHandlerTime);
    }
  });

  test("assistant-broadcast events (no conversationId) always reach the handler regardless of switching", () => {
    const observeKey = { current: "" };
    const { rerender, captured } = renderEventStreamWithCapture(
      "conv-A",
      observeKey,
    );
    publish("sse.event", {
      id: "evt-sync-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "sync_changed",
        tags: ["assistant:self:identity"],
      },
    } as AssistantEventEnvelope);
    act(() => {
      rerender({ key: "conv-B" });
    });
    publish("sse.event", {
      id: "evt-sync-2",
      emittedAt: new Date().toISOString(),
      message: {
        type: "sync_changed",
        tags: ["assistant:self:avatar"],
      },
    } as AssistantEventEnvelope);
    expect(captured).toHaveLength(2);
    expect((captured[0]!.event as { type: string }).type).toBe("sync_changed");
    expect((captured[1]!.event as { type: string }).type).toBe("sync_changed");
  });

  test("unmounting mid-burst stops further delivery", () => {
    const observeKey = { current: "" };
    const { unmount, captured } = renderEventStreamWithCapture(
      "conv-A",
      observeKey,
    );
    publishDelta("conv-A");
    publishDelta("conv-A");
    expect(captured).toHaveLength(2);
    unmount();
    publishDelta("conv-A");
    publishDelta("conv-A");
    publishDelta("conv-A");
    expect(captured).toHaveLength(2);
  });
});
