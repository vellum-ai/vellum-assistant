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
  setLastSeenSeq: (cid: string, seq: number) => seqStore.set(cid, seq),
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
}) => override;

const makeDeps = (override: {
  activeConversationId?: string | null;
  reconcileActive?: () => void;
  handleStreamEvent?: (event: AssistantEvent, epoch: number) => void;
} = {}) => {
  const activeConversationIdRef = {
    current: override.activeConversationId ?? "conv-1",
  };
  const reconcileActive = override.reconcileActive ?? mock(() => {});
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

describe("sse-event-consumer — seq-gap detection", () => {
  test("first event seeds the cursor without reconciling", () => {
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 100,
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
        seq: 5,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 6,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).not.toHaveBeenCalled();
    expect(seqStore.get("conv-1")).toBe(6);
  });

  test("gap (seq > stored + 1) triggers reconcile and skips cursor advancement", () => {
    seqStore.set("conv-1", 5);
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Seed the cursor.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
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
        seq: 10,
        message: {
          type: "assistant_text_delta",
          text: "b",
        },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(seqStore.get("conv-1")).toBe(5); // Cursor pinned at 5 — reconcile will deliver authoritative state.
  });

  test("counter-reset (seq < stored) replaces the cursor and reconciles", () => {
    seqStore.set("conv-1", 500);
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 500,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    // Daemon restart → server resets seq back to 3.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 3,
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
        seq: 5,
        message: {
          type: "assistant_text_delta",
          text: "a",
        },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 50,
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
});
