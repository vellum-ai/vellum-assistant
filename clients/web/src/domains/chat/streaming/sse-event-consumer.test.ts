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
  now?: () => number;
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
      now: override.now,
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

  test("open_url with no envelope conversationId passes through", () => {
    const { deps, handleStreamEvent } = makeDeps();
    const consumer = createSseEventConsumer(deps);

    // CLI-initiated emits (signals/emit-event bridge) have no conversation
    // binding, so the envelope carries no conversationId — the event must
    // still reach `handleOpenUrl` instead of being dropped as unscoped.
    consumer.handleSseEvent(
      makeEnvelope({
        message: { type: "open_url", url: "https://example.com/authorize" },
      }),
    );

    expect(handleStreamEvent).toHaveBeenCalledTimes(1);
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "sse_event_wrong_conversation_filtered",
      expect.anything(),
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

  test("a ring-exceeding gap caused by an event on a background conversation is still detected", () => {
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

    // WHEN a background conversation's event jumps the global seq past the
    // replay-ring bound (events have certainly been evicted)
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-2",
        seq: 5 + 200,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    // THEN gap detection fires even though the event was for another
    // conversation — the connection missed events.
    expect(reconcileActive).toHaveBeenCalledTimes(1);
  });

  test("a small gap within the ring bound is benign — no reconcile, cursor advances, event dispatches", () => {
    // GIVEN a consumer scoped to conv-1 with a seeded cursor
    const { deps, reconcileActive, handleStreamEvent } = makeDeps({
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

    // WHEN the seq skips by a small amount — e.g. the client's own
    // self-echo-suppressed `sync_changed` burned a seq it never receives,
    // so its next event lands at stored + 2.
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 7,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    // THEN the gap is treated as benign: no destructive authoritative
    // reconcile, the cursor advances past the skipped seq, and the event
    // still dispatches as part of a contiguous stream.
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(globalCursor).toBe(7);
    expect(handleStreamEvent).toHaveBeenCalledTimes(2);
  });

  test("a small gap after the connection has been quiet past the ring age window heals authoritatively", async () => {
    /**
     * The replay ring also evicts by age (30s), so a small seq delta is
     * NOT proof the hole is recoverable: after a quiet stretch longer than
     * the age window (a disconnect/resume), the few skipped events may have
     * aged out of the ring and become unreplayable. In that case even a
     * tiny gap must heal authoritatively rather than be waved through.
     */
    // GIVEN a clock we control and a seeded cursor at t=0
    let clock = 0;
    const { deps, reconcileActive } = makeDeps({ now: () => clock });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN the connection goes quiet past the ring's age window and then a
    // small seq gap arrives
    clock = 30_000;
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 7,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // THEN the gap is treated as a potential out-of-ring loss and healed
    expect(reconcileActive).toHaveBeenCalledTimes(1);
  });

  test("a small gap within the ring age window stays benign", () => {
    // GIVEN a clock we control and a seeded cursor at t=0
    let clock = 0;
    const { deps, reconcileActive } = makeDeps({ now: () => clock });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN a small seq gap arrives while the stream is still actively
    // delivering (just under the age window)
    clock = 29_999;
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 7,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );

    // THEN it is benign — the cursor advances with no reconcile
    expect(reconcileActive).not.toHaveBeenCalled();
    expect(globalCursor).toBe(7);
  });

  test("a ring-exceeding seq gap fires an authoritative reconcile and advances the cursor once it resolves", async () => {
    /**
     * A gap at or beyond the replay-ring count bound means events were
     * evicted, so the live suffix is non-contiguous. The consumer
     * reconciles (the wiring makes it authoritative) and, once the snapshot
     * heal resolves, advances the cursor to the live frontier — the hole is
     * healed by the snapshot, not by replaying it, so the cursor follows the
     * frontier rather than wedging on the gap.
     */
    // GIVEN a consumer with a seeded cursor and a resolving reconcile
    const reconcileActive = mock(() => Promise.resolve());
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN an event jumps the global seq past the ring's count bound
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5 + 200,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    // The cursor advance is deferred to the reconcile, so drain microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // THEN a single reconcile fired and the cursor follows the frontier
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(205);
  });

  test("a burst of gaps fires a single debounced reconcile and advances to the latest frontier once it settles", async () => {
    /**
     * While one authoritative reconcile is in-flight a further gap must not
     * fire a second concurrent fetch (the in-flight one already reloads the
     * whole snapshot). The cursor stays pinned until the heal settles, then
     * jumps straight to the latest frontier seen so the stream resumes from
     * the live position.
     */
    // GIVEN a consumer whose reconcile stays in-flight
    let resolveReconcile!: () => void;
    let reconcilePromise = new Promise<void>((r) => {
      resolveReconcile = r;
    });
    const reconcileActive = mock(() => reconcilePromise);
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN a ring-exceeding gap fires a reconcile and a second such gap
    // arrives before it resolves
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5 + 200,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5 + 220,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );

    // THEN only one reconcile fired and the cursor stays pinned while it is
    // in flight (advancing now would strand the hole if the heal fails)
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(5);

    // AND once it settles the cursor jumps to the latest frontier seen
    resolveReconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(globalCursor).toBe(225);

    // AND the debounce releases so a later ring-exceeding gap reconciles again
    reconcilePromise = Promise.resolve();
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 225 + 200,
        message: { type: "assistant_text_delta", text: "d" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcileActive).toHaveBeenCalledTimes(2);
    expect(globalCursor).toBe(425);
  });

  test("a failed gap reconcile keeps the cursor pinned and retries on the next event", async () => {
    /**
     * If the authoritative snapshot fetch rejects (a transient `/messages`
     * failure), the cursor must NOT advance past the gap — advancing would
     * mark the missing seqs as seen and the hole would survive until the
     * next reconnect. Pinning the cursor makes the next live event re-detect
     * the gap and retry the heal.
     */
    // GIVEN a consumer whose reconcile rejects
    const reconcileActive = mock(() => Promise.reject(new Error("network")));
    const { deps } = makeDeps({ reconcileActive });
    const consumer = createSseEventConsumer(deps);
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5,
        message: { type: "assistant_text_delta", text: "a" },
      }),
    );

    // WHEN a ring-exceeding gap fires the reconcile and it rejects
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5 + 200,
        message: { type: "assistant_text_delta", text: "b" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // THEN the cursor stays pinned at the pre-gap position
    expect(reconcileActive).toHaveBeenCalledTimes(1);
    expect(globalCursor).toBe(5);

    // AND the next live event (still far past the pinned cursor) re-detects
    // the gap and retries the reconcile
    consumer.handleSseEvent(
      makeEnvelope({
        conversationId: "conv-1",
        seq: 5 + 201,
        message: { type: "assistant_text_delta", text: "c" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcileActive).toHaveBeenCalledTimes(2);
    expect(globalCursor).toBe(5);
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
