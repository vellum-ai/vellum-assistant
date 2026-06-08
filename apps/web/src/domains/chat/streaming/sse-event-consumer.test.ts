import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetLocalSeqForTesting,
  getLocalSeq,
} from "@/lib/streaming/local-seq";
import type { AssistantEvent } from "@/types/event-types";

let mockStreamEpoch = 7;
mock.module("@/domains/chat/stream-store", () => ({
  useStreamStore: {
    getState: () => ({ streamEpoch: mockStreamEpoch }),
  },
}));

// Single global cursor mock mirroring reconnect-cursor.ts semantics.
let globalCursor: number | null = null;
mock.module("@/lib/streaming/reconnect-cursor", () => ({
  getReconnectCursor: () => globalCursor,
  // Monotonic — matches the real implementation (won't lower the cursor).
  advanceReconnectCursor: (seq: number) => {
    if (globalCursor === null || seq > globalCursor) {
      globalCursor = seq;
    }
  },
  // Unconditional — used for generation resets and gap resolves.
  replaceReconnectCursor: (seq: number) => {
    globalCursor = seq;
  },
  resetReconnectCursor: () => {
    globalCursor = null;
  },
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
  mockStreamEpoch = 7;
  globalCursor = null;
  __resetLocalSeqForTesting();
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
  test("first event on a cold connection seeds the cursor without reconciling", () => {
    // GIVEN a fresh consumer with no global cursor yet
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // WHEN the first conversation-scoped event arrives
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

    // THEN it seeds the cursor without a reconcile
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(globalCursor).toBe(100);
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
    expect(globalCursor).toBe(6);
  });

  test("events interleaved across conversations stay contiguous on one global cursor", () => {
    // GIVEN a consumer scoped to conv-1
    const { deps, reconcileActive, handleStreamEvent } = makeDeps({
      activeConversationId: "conv-1",
    });
    const consumer = createSseEventConsumer(deps);

    // WHEN events from two conversations interleave with a contiguous
    // global seq (5 conv-1, 6 conv-2, 7 conv-1)
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-2",
        seq: 6,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 7,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );

    // THEN no gap is detected (the global seq is contiguous), the
    // cursor advances across conversations, and only the active
    // conversation's events are dispatched.
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(globalCursor).toBe(7);
    expect(handleStreamEvent).toHaveBeenCalledTimes(2);
  });

  test("a gap caused by an event on a background conversation is still detected", () => {
    // GIVEN a consumer scoped to conv-1 with a seeded cursor
    const { deps, reconcileActive } = makeDeps({ activeConversationId: "conv-1" });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN a background conversation's event jumps the global seq
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-2",
        seq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    // THEN gap detection fires even though the event was for another
    // conversation — the connection missed events.
    expect(reconcileActive).toHaveBeenCalledTimes(1);
  });

  test("gap (seq > stored + 1) triggers reconcile, cursor advances only after resolve", async () => {
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
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
    // Cursor stays pinned while reconcile is in-flight.
    expect(globalCursor).toBe(5);

    // Resolve the reconcile — cursor should advance.
    resolveReconcile();
    await reconcilePromise;
    // Let microtask (.then) run.
    await Promise.resolve();
    expect(globalCursor).toBe(10);
  });

  test("gap reconcile failure leaves cursor pinned for retry", async () => {
    let rejectReconcile!: () => void;
    const reconcilePromise = new Promise<void>((_, rej) => { rejectReconcile = rej; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(5); // Pinned.

    // Reject the reconcile.
    rejectReconcile();
    await reconcilePromise.catch(() => {});
    await Promise.resolve();
    // Cursor still pinned — next event should re-trigger.
    expect(globalCursor).toBe(5);

    // Next event: still a gap (stored=5, seq=11) → retries reconcile.
    const retryPromise = Promise.resolve();
    reconcileActive.mockReturnValueOnce(retryPromise);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 11,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    expect(reconcileActive).toHaveBeenCalledTimes(2);
    await retryPromise;
    await Promise.resolve();
    expect(globalCursor).toBe(11);
  });

  test("gap reconcile debounces — events during in-flight track latest seq", async () => {
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap event 1.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    // More events while reconcile is in-flight — debounced.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 11,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 12,
        message: { type: "assistant_text_delta", text: "d" },
      }),
    );

    // Only one reconcile fired.
    expect(reconcileActive).toHaveBeenCalledTimes(1);

    // Resolve — cursor jumps to latest (12), not the gap event (10).
    resolveReconcile();
    await reconcilePromise;
    await Promise.resolve();
    expect(globalCursor).toBe(12);
  });

  test("gap reconcile does not advance cursor when the stream reconnected (epoch changed) during reconcile", async () => {
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>((r) => { resolveReconcile = r; });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);

    // Seed.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );
    // Gap.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 10,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(5); // Pinned.

    // The SSE stream reconnects (new epoch) while the reconcile is
    // in-flight, making this reconcile's result stale.
    mockStreamEpoch = 8;

    // Resolve the reconcile — cursor should NOT advance because the
    // epoch no longer matches the one captured when reconcile started.
    resolveReconcile();
    await reconcilePromise;
    await Promise.resolve();
    expect(globalCursor).toBe(5); // Still pinned.
  });

  test("counter-reset (seq < stored) replaces the cursor synchronously and reconciles", () => {
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
    expect(globalCursor).toBe(3);
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

  test("a backwards seq on the first event of a warm cursor is a generation reset", () => {
    // GIVEN a global cursor left at seq=10 by prior connection activity
    globalCursor = 10;
    const { deps, reconcileActive } = makeDeps();
    const consumer = createSseEventConsumer(deps);
    deps.activeConversationIdRef.current = "conv-1";

    // WHEN the first event after a daemon restart arrives with a lower
    // seq (the global counter reset)
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 6,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // THEN a generation reset fires a reconcile and the cursor is
    // replaced to the new (lower) seq.
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(6);
  });
});

describe("sse-event-consumer — per-conversation idempotent apply", () => {
  test("an applied event advances the conversation's frontier", () => {
    /**
     * The frontier records how far the stream has carried the active
     * conversation so the snapshot/stream merge knows the live position.
     */
    // GIVEN a fresh consumer for the active conversation
    const { deps, handleStreamEvent } = makeDeps({
      activeConversationId: "conv-1",
    });
    const consumer = createSseEventConsumer(deps);

    // WHEN a conversation-scoped event is applied
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // THEN it dispatches and the frontier advances to its seq
    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
    expect(getLocalSeq("conv-1")).toBe(5);
  });

  test("re-delivering the frontier event is skipped as a replay", () => {
    /**
     * A reconnect can re-deliver the boundary event the conversation has
     * already applied. Re-running the handler would double-append the delta,
     * so an event whose seq is at or below the frontier is dropped.
     */
    // GIVEN an event at seq 5 has already been applied
    const { deps, handleStreamEvent } = makeDeps({
      activeConversationId: "conv-1",
    });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN the same seq is re-delivered
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // THEN the replay is not re-dispatched, is diagnosed, and the frontier
    // holds steady
    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "sse_event_seq_replayed",
      expect.objectContaining({ conversationId: "conv-1", eventSeq: 5 }),
    );
    expect(getLocalSeq("conv-1")).toBe(5);
  });
});
