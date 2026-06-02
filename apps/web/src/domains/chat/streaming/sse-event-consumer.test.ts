import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "@/types/event-types";

let mockStreamEpoch = 7;
mock.module("@/domains/chat/stream-store", () => ({
  useStreamStore: {
    getState: () => ({ streamEpoch: mockStreamEpoch }),
  },
}));

let seqGapEnabled = true;
mock.module("@/lib/feature-flags/seq-gap-detection-flag", () => ({
  isSeqGapDetectionEnabled: () => seqGapEnabled,
}));

const seqStore = new Map<string, number>();
mock.module("@/lib/streaming/last-seen-seq", () => ({
  getLastSeenSeq: (cid: string) => seqStore.get(cid) ?? null,
  // Monotonic — matches real implementation (won't lower the cursor).
  setLastSeenSeq: (cid: string, seq: number) => {
    const current = seqStore.get(cid);
    if (current !== undefined && seq <= current) return;
    seqStore.set(cid, seq);
  },
  // Unconditional — used for generation resets and reconnect reseeds.
  replaceLastSeenSeq: (cid: string, seq: number) => seqStore.set(cid, seq),
}));

const recordDiagnosticMock = mock(() => {});
mock.module("@/lib/diagnostics", () => ({
  recordDiagnostic: recordDiagnosticMock,
}));

const { createSseEventConsumer } = await import(
  "@/domains/chat/streaming/sse-event-consumer"
);

// Test fixture builds a `ConsumableEnvelope` — the narrow input type
// the consumer actually reads. The runtime envelope from the bus
// carries more fields (id, emittedAt, etc.) but the consumer only
// touches the three below, so the fixture matches that surface
// exactly without lying about the wider shape.
const makeEnvelope = (override: {
  message: AssistantEvent;
  conversationId?: string;
  seq?: number;
  clientSeq?: number;
}) => override;

const makeDeps = (override: {
  activeConversationId?: string | null;
  reconcileActive?: () => Promise<unknown>;
  handleStreamEvent?: (event: AssistantEvent, epoch: number) => void;
} = {}) => {
  const activeConversationIdRef = {
    current: override.activeConversationId ?? "conv-1",
  };
  const reconcileActive = override.reconcileActive ?? mock(() => Promise.resolve());
  const handleStreamEvent = override.handleStreamEvent ?? mock(() => {});
  return {
    activeConversationIdRef,
    reconcileActive,
    handleStreamEvent,
    deps: {
      activeConversationIdRef,
      reconcileActive,
      handleStreamEvent,
    },
  };
};

beforeEach(() => {
  seqGapEnabled = true;
  mockStreamEpoch = 7;
  seqStore.clear();
  recordDiagnosticMock.mockClear();
});

describe("sse-event-consumer — cross-conversation filter", () => {
  test("global events (e.g. sync_changed) always pass through", () => {
    const { deps, handleStreamEvent } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        // sync_changed is not conversation-scoped per the chat utils
        message: { type: "sync_changed", tags: ["x"] },
      }),
    );

    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
  });

  test("conversation event matching the active key passes through", () => {
    const { deps, handleStreamEvent } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        message: {
          type: "assistant_text_delta",
          text: "hi",
        },
      }),
    );

    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
  });

  test("conversation event with mismatched conversationId is dropped + diagnosed", () => {
    const { deps, handleStreamEvent } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-OTHER",
        message: {
          type: "assistant_text_delta",
          text: "hi",
        },
      }),
    );

    expect(handleStreamEvent).not.toHaveBeenCalled();
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "sse_event_wrong_conversation_filtered",
      expect.objectContaining({ reason: "mismatch" }),
    );
  });

  test("conversation event with missing conversationId is dropped + diagnosed", () => {
    const { deps, handleStreamEvent } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        message: {
          type: "assistant_text_delta",
          text: "hi",
        },
      }),
    );

    expect(handleStreamEvent).not.toHaveBeenCalled();
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "sse_event_wrong_conversation_filtered",
      expect.objectContaining({ reason: "missing" }),
    );
  });

  test("event dispatch passes the current epoch", () => {
    const { deps, handleStreamEvent } = makeDeps();
    mockStreamEpoch = 42;
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        message: {
          type: "assistant_text_delta",
          text: "hi",
        },
      }),
    );

    expect(handleStreamEvent).toHaveBeenCalledWith(expect.anything(), 42);
  });
});

describe("sse-event-consumer — clientSeq gap detection", () => {
  test("first event seeds the cursor without reconciling", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 100,
        message: {
          type: "assistant_text_delta",
          text: "x",
        },
      }),
    );

    expect(reconcileActive).not.toHaveBeenCalled();
    expect(seqStore.get("conv-1")).toBe(100);
  });

  test("contiguous events advance the cursor", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 6,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).not.toHaveBeenCalled();
    expect(seqStore.get("conv-1")).toBe(6);
  });

  test("gap (clientSeq > stored + 1) triggers reconcile, cursor advances only after resolve", async () => {
    seqStore.set("conv-1", 5);
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed the cursor.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    // Gap: jumps from 5 to 10.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 10,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    // Cursor stays pinned while reconcile is in-flight.
    expect(seqStore.get("conv-1")).toBe(5);

    // Resolve the reconcile — cursor should advance.
    resolveReconcile();
    await reconcilePromise;
    // Let microtask (.then) run.
    await Promise.resolve();
    expect(seqStore.get("conv-1")).toBe(10);
  });

  test("gap reconcile failure leaves cursor pinned for retry", async () => {
    seqStore.set("conv-1", 5);
    let rejectReconcile!: () => void;
    const reconcilePromise = new Promise<void>((_, rej) => { rejectReconcile = rej; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(seqStore.get("conv-1")).toBe(5); // Pinned.

    // Reject the reconcile.
    rejectReconcile();
    await reconcilePromise.catch(() => {});
    await Promise.resolve();
    // Cursor still pinned — next event should re-trigger.
    expect(seqStore.get("conv-1")).toBe(5);

    // Next event: still a gap (stored=5, clientSeq=11) → retries reconcile.
    const retryPromise = Promise.resolve();
    reconcileActive.mockReturnValueOnce(retryPromise);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 11,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    expect(reconcileActive).toHaveBeenCalledTimes(2);
    await retryPromise;
    await Promise.resolve();
    expect(seqStore.get("conv-1")).toBe(11);
  });

  test("gap reconcile debounces — events during in-flight track latest clientSeq", async () => {
    seqStore.set("conv-1", 5);
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap event 1.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    // More events while reconcile is in-flight — debounced.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 11,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 12,
        message: { type: "assistant_text_delta", text: "d" },
      }),
    );

    // Only one reconcile fired.
    expect(reconcileActive).toHaveBeenCalledTimes(1);

    // Resolve — cursor jumps to latest (12), not the gap event (10).
    resolveReconcile();
    await reconcilePromise;
    await Promise.resolve();
    expect(seqStore.get("conv-1")).toBe(12);
  });

  test("gap reconcile does not advance cursor when conversation switched during reconcile", async () => {
    seqStore.set("conv-1", 5);
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps, activeConversationIdRef } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(seqStore.get("conv-1")).toBe(5); // Pinned.

    // User switches conversation while reconcile is in-flight.
    activeConversationIdRef.current = "conv-2";

    // Resolve the reconcile — cursor should NOT advance because
    // the conversation is no longer active.
    resolveReconcile();
    await reconcilePromise;
    await Promise.resolve();
    expect(seqStore.get("conv-1")).toBe(5); // Still pinned.
  });

  test("counter-reset (clientSeq < stored) replaces the cursor synchronously and reconciles", () => {
    seqStore.set("conv-1", 500);
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 500,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    // Subscriber counter reset without a reconnect signal → clientSeq
    // drops back to 3.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 3,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(seqStore.get("conv-1")).toBe(3);
  });

  test("with seqGapEnabled=false, no gap detection runs and no cursor is written", () => {
    seqGapEnabled = false;
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 5,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 50,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).not.toHaveBeenCalled();
    expect(seqStore.get("conv-1")).toBeUndefined();
  });

  test("active-conversation key is read from the ref on every event (commit-phase update)", () => {
    const { deps, handleStreamEvent, activeConversationIdRef } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Initial commit-phase active key is "conv-1" — this event passes.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        message: {
          type: "assistant_text_delta",
          text: "first",
        },
      }),
    );
    expect(handleStreamEvent).toHaveBeenCalledTimes(1);

    // Simulate a conversation switch — caller updates the ref in
    // useLayoutEffect commit phase.
    activeConversationIdRef.current = "conv-2";

    // An in-flight event for the old conversation must now be rejected.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        message: {
          type: "assistant_text_delta",
          text: "stale",
        },
      }),
    );

    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
  });

  test("ignores the global seq — only clientSeq drives gap detection", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Seed with clientSeq=1 (seq=5 — simulating targeted events
    // consuming global seq numbers 1-4 that this subscriber never
    // received).
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        clientSeq: 1,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Cursor is seeded at clientSeq=1, not the global seq=5.
    expect(seqStore.get("conv-1")).toBe(1);

    // Next event: clientSeq=2 (contiguous), seq=10 (a jump in the global
    // seq from this subscriber's perspective, but irrelevant since only
    // clientSeq is read).
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 10,
        clientSeq: 2,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    // No gap detected — clientSeq 2 follows 1 contiguously.
    expect(seqStore.get("conv-1")).toBe(2);
    expect(reconcileActive).not.toHaveBeenCalled();
  });

  test("does not run gap detection when clientSeq is absent", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // The daemon always stamps clientSeq; an envelope without it carries
    // no gap-detection signal, so the consumer neither seeds a cursor nor
    // reconciles (it does not fall back to the global seq).
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 1,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 50,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).not.toHaveBeenCalled();
    expect(seqStore.get("conv-1")).toBeUndefined();
  });

  test("clientSeq gap triggers reconcile even when the global seq is contiguous", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 1,
        clientSeq: 1,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // clientSeq jumps from 1 to 3 (gap) even though the global seq is
    // contiguous — gap detection keys off clientSeq.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 2,
        clientSeq: 3,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
  });

  test("notifyReconnect prevents false generation reset when clientSeq resets to 1", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Establish cursor at clientSeq=10 (simulating a long-lived connection).
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 10,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    expect(seqStore.get("conv-1")).toBe(10);

    // SSE reconnects — server creates fresh clientSeq counter.
    consumer.notifyReconnect();

    // First post-reconnect event: clientSeq=1. Without notifyReconnect,
    // this would trigger the generation-reset path (1 < 10). With it,
    // the event re-seeds the cursor instead.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 1,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    // No reconcile fired — the event was treated as a seed, not a reset.
    expect(reconcileActive).not.toHaveBeenCalled();
    // The NEXT contiguous event advances the re-seeded cursor.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 2,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    expect(seqStore.get("conv-1")).toBe(2);
    expect(reconcileActive).not.toHaveBeenCalled();
  });

  test("new consumer reseeds the clientSeq cursor even without notifyReconnect (reconnect while unmounted)", () => {
    const { deps, reconcileActive } = makeDeps();

    // Simulate a previous consumer having established cursor at
    // clientSeq=10 before being destroyed (conversation switch).
    seqStore.set("conv-1", 10);

    // New consumer — SSE reconnected while the old consumer was
    // unmounted, so notifyReconnect() was never called. The server's
    // clientSeq counters have reset to 1.
    const consumer = createSseEventConsumer(deps);
    deps.activeConversationIdRef.current = "conv-1";

    // First event (seed): clientSeq=1. Without the reseed, the monotonic
    // setLastSeenSeq(1) is rejected (1 <= 10) and the cursor stays
    // stale. With it, the seed uses replaceLastSeenSeq.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 1,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // Cursor should be reseeded to 1.
    expect(seqStore.get("conv-1")).toBe(1);

    // Second event contiguous — should NOT trigger generation reset.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        clientSeq: 2,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(seqStore.get("conv-1")).toBe(2);
    // No reconcile — both events are contiguous after reseed.
    expect(reconcileActive).not.toHaveBeenCalled();
  });
});
