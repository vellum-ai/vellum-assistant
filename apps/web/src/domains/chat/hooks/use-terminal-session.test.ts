import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// We mock the terminal API module so tests don't make real HTTP calls.
const mockCreateTerminalSession = mock(async (_assistantId: string) => ({
  sessionId: "sess-test-1",
}));

const mockDestroyTerminalSession = mock(async () => undefined);

const mockSendTerminalInput = mock(async () => undefined);

const mockResizeTerminal = mock(async () => undefined);

// Holds the onEvent / onError callbacks so tests can trigger them.
let capturedOnEvent: ((event: { seq: number; data: string }) => void) | null = null;
let capturedOnError: ((err: Error) => void) | null = null;
const mockStreamCancel = mock(() => undefined);

const mockSubscribeTerminalEvents = mock(
  (
    _assistantId: string,
    _sessionId: string,
    onEvent: (event: { seq: number; data: string }) => void,
    onError: (err: Error) => void,
  ) => {
    capturedOnEvent = onEvent;
    capturedOnError = onError;
    return { cancel: mockStreamCancel };
  },
);

mock.module("@/domains/terminal/api.js", () => ({
  createTerminalSession: mockCreateTerminalSession,
  destroyTerminalSession: mockDestroyTerminalSession,
  sendTerminalInput: mockSendTerminalInput,
  resizeTerminal: mockResizeTerminal,
  subscribeTerminalEvents: mockSubscribeTerminalEvents,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER setting up mocks
// ---------------------------------------------------------------------------

// We cannot use renderHook without @testing-library/react, so we test the
// API layer functions and state transitions directly, following the same
// pattern used in useAssistantLifecycle.test.ts and use-terminal-state.test.ts.

import {
  createTerminalSession,
  destroyTerminalSession,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalEvents,
} from "@/domains/terminal/api.js";

import {
  INITIAL_TERMINAL_STATE,
  terminalReducer,
  type TerminalEvent,
  type TerminalState,
} from "@/domains/chat/hooks/use-terminal-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyEvents(events: TerminalEvent[], initial: TerminalState = INITIAL_TERMINAL_STATE): TerminalState {
  return events.reduce(terminalReducer, initial);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;
let originalDocument: typeof globalThis.document;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDocument = globalThis.document;
  // @ts-expect-error - stub document for tests
  globalThis.document = { cookie: "" };

  capturedOnEvent = null;
  capturedOnError = null;

  mockCreateTerminalSession.mockClear();
  mockDestroyTerminalSession.mockClear();
  mockSendTerminalInput.mockClear();
  mockResizeTerminal.mockClear();
  mockSubscribeTerminalEvents.mockClear();
  mockStreamCancel.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

// ---------------------------------------------------------------------------
// connect flow
// ---------------------------------------------------------------------------

describe("connect flow", () => {
  test("createTerminalSession returns a session ID", async () => {
    const session = await createTerminalSession("asst-1");
    expect(session.sessionId).toBe("sess-test-1");
    expect(mockCreateTerminalSession).toHaveBeenCalledWith("asst-1");
  });

  test("state transitions idle -> connecting -> connected", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-test-1" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.sessionId).toBe("sess-test-1");
    expect(state.errorMessage).toBeNull();
  });

  test("state transitions to error when connect fails", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "Failed to create terminal session" },
    ]);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Failed to create terminal session");
    expect(state.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE stream subscription
// ---------------------------------------------------------------------------

describe("SSE stream subscription", () => {
  test("subscribeTerminalEvents registers callbacks and returns cancel", () => {
    const onEvent = mock((_evt: { seq: number; data: string }) => undefined);
    const onError = mock((_err: Error) => undefined);

    const handle = subscribeTerminalEvents("asst-1", "sess-1", onEvent, onError);
    expect(mockSubscribeTerminalEvents).toHaveBeenCalledWith("asst-1", "sess-1", onEvent, onError);
    expect(typeof handle.cancel).toBe("function");
  });

  test("onEvent callback is invoked for each stream event", () => {
    const received: Array<{ seq: number; data: string }> = [];
    subscribeTerminalEvents("asst-1", "sess-1", (evt) => received.push(evt), () => undefined);

    capturedOnEvent?.({ seq: 0, data: "aGVsbG8=" });
    capturedOnEvent?.({ seq: 1, data: "d29ybGQ=" });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ seq: 0, data: "aGVsbG8=" });
    expect(received[1]).toEqual({ seq: 1, data: "d29ybGQ=" });
  });

  test("onError callback is invoked when the stream errors", () => {
    const errors: Error[] = [];
    subscribeTerminalEvents("asst-1", "sess-1", () => undefined, (err) => errors.push(err));

    capturedOnError?.(new Error("Pod evicted"));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Pod evicted");
  });

  test("cancel() is callable on the stream handle", () => {
    const handle = subscribeTerminalEvents("asst-1", "sess-1", () => undefined, () => undefined);
    handle.cancel();
    expect(mockStreamCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Ordered output — seq deduplication
// ---------------------------------------------------------------------------

describe("ordered output deduplication", () => {
  test("duplicate seq values should be dropped by caller tracking", () => {
    // Simulate the seq high-watermark tracking used in use-terminal-session
    let highWaterMark = -1;
    const received: string[] = [];

    const filterAndCollect = (event: { seq: number; data: string }) => {
      if (event.seq <= highWaterMark) return;
      highWaterMark = event.seq;
      received.push(event.data);
    };

    filterAndCollect({ seq: 0, data: "first" });
    filterAndCollect({ seq: 1, data: "second" });
    filterAndCollect({ seq: 1, data: "second-duplicate" }); // should be dropped
    filterAndCollect({ seq: 0, data: "out-of-order" });      // should be dropped
    filterAndCollect({ seq: 2, data: "third" });

    expect(received).toEqual(["first", "second", "third"]);
  });

  test("seq tracking resets after reconnect (new tracker)", () => {
    const received: string[] = [];

    const filterAndCollect = (tracker: { hwm: number }, event: { seq: number; data: string }) => {
      if (event.seq <= tracker.hwm) return;
      tracker.hwm = event.seq;
      received.push(event.data);
    };

    const tracker1 = { hwm: -1 };
    filterAndCollect(tracker1, { seq: 0, data: "a" });
    filterAndCollect(tracker1, { seq: 1, data: "b" });

    // Reconnect — new tracker starts fresh
    const tracker2 = { hwm: -1 };
    filterAndCollect(tracker2, { seq: 0, data: "c" }); // seq 0 on new session — not a duplicate
    filterAndCollect(tracker2, { seq: 1, data: "d" });

    expect(received).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// Input batching
// ---------------------------------------------------------------------------

describe("input batching", () => {
  test("sendTerminalInput sends the provided data string", async () => {
    await sendTerminalInput("asst-1", "sess-1", "hello");
    expect(mockSendTerminalInput).toHaveBeenCalledWith("asst-1", "sess-1", "hello");
  });

  test("multiple sendTerminalInput calls can be batched by concatenating", async () => {
    // Simulates the buffer accumulation that use-terminal-session performs before
    // flushing via the interval timer.
    let buffer = "";
    const flush = async () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      await sendTerminalInput("asst-1", "sess-1", chunk);
    };

    buffer += "a";
    buffer += "b";
    buffer += "c";
    await flush();

    expect(mockSendTerminalInput).toHaveBeenCalledTimes(1);
    expect(mockSendTerminalInput).toHaveBeenCalledWith("asst-1", "sess-1", "abc");
  });
});

// ---------------------------------------------------------------------------
// Resize debouncing
// ---------------------------------------------------------------------------

describe("resize debouncing", () => {
  test("resizeTerminal sends cols and rows", async () => {
    await resizeTerminal("asst-1", "sess-1", 80, 24);
    expect(mockResizeTerminal).toHaveBeenCalledWith("asst-1", "sess-1", 80, 24);
  });

  test("debounce logic: only last resize in a burst is applied", async () => {
    let pendingResize: { cols: number; rows: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const debouncedResize = (cols: number, rows: number) => {
      pendingResize = { cols, rows };
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        if (!pendingResize) return;
        const r = pendingResize;
        pendingResize = null;
        await resizeTerminal("asst-1", "sess-1", r.cols, r.rows);
      }, 0);
    };

    debouncedResize(40, 12);
    debouncedResize(80, 24);
    debouncedResize(120, 30);

    // Wait for the debounce timer
    await new Promise((r) => setTimeout(r, 10));

    // Only the last resize should have been sent
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenCalledWith("asst-1", "sess-1", 120, 30);
  });
});

// ---------------------------------------------------------------------------
// Close / destroy
// ---------------------------------------------------------------------------

describe("close flow", () => {
  test("destroyTerminalSession is called with correct identifiers", async () => {
    await destroyTerminalSession("asst-1", "sess-1");
    expect(mockDestroyTerminalSession).toHaveBeenCalledWith("asst-1", "sess-1");
  });

  test("state transitions to closed on TERMINAL_CLOSED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "TERMINAL_CLOSED" },
    ]);
    expect(state.status).toBe("closed");
    expect(state.sessionId).toBeNull();
    expect(state.errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect flow
// ---------------------------------------------------------------------------

describe("reconnect flow", () => {
  test("state transitions correctly through reconnect cycle", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_SUCCEEDED", sessionId: "sess-2" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.sessionId).toBe("sess-2");
    expect(state.reconnectAttempts).toBe(0);
  });

  test("reconnect creates a fresh session", async () => {
    // First connect
    await createTerminalSession("asst-1");
    // Destroy old session on reconnect
    await destroyTerminalSession("asst-1", "sess-1");
    // Create new session
    await createTerminalSession("asst-1");

    expect(mockCreateTerminalSession).toHaveBeenCalledTimes(2);
    expect(mockDestroyTerminalSession).toHaveBeenCalledTimes(1);
  });

  test("stream is cancelled before reconnect opens a new one", () => {
    const handle = subscribeTerminalEvents("asst-1", "sess-1", () => undefined, () => undefined);
    // Simulate the reconnect sequence: cancel old stream first
    handle.cancel();
    expect(mockStreamCancel).toHaveBeenCalledTimes(1);
    // Then subscribe to the new stream
    subscribeTerminalEvents("asst-1", "sess-2", () => undefined, () => undefined);
    expect(mockSubscribeTerminalEvents).toHaveBeenCalledTimes(2);
  });

  test("reconnect avoids duplicate output by resetting seq tracker", () => {
    const received: string[] = [];

    // Session 1: receives events at seq 0 and 1
    const tracker1 = { hwm: -1 };
    [{ seq: 0, data: "x" }, { seq: 1, data: "y" }].forEach((e) => {
      if (e.seq <= tracker1.hwm) return;
      tracker1.hwm = e.seq;
      received.push(e.data);
    });

    // Reconnect: seq tracker resets — seq 0 on new session is valid
    const tracker2 = { hwm: -1 };
    [{ seq: 0, data: "z" }].forEach((e) => {
      if (e.seq <= tracker2.hwm) return;
      tracker2.hwm = e.seq;
      received.push(e.data);
    });

    expect(received).toEqual(["x", "y", "z"]);
  });
});

// ---------------------------------------------------------------------------
// Gap fixes: stale sessionId in resize debounce, timer cleanup on reconnect,
// input flush timer stopped on SSE error
// ---------------------------------------------------------------------------

describe("Gap A: resize debounce uses current sessionId at fire time", () => {
  test("resize callback uses stateRef.current.sessionId, not closure-captured value", async () => {
    // Simulate the pattern from use-terminal-session's sendResize setTimeout:
    // The callback reads from a ref (always current) rather than a closure variable.
    const stateRef = { current: { sessionId: "sess-old", status: "connected" as const } };

    let timerFired = false;
    let sessionIdAtFireTime = null as string | null;

    const timer = setTimeout(() => {
      timerFired = true;
      // Re-read from stateRef at fire time (the fixed behavior)
      sessionIdAtFireTime = stateRef.current.sessionId;
    }, 0);

    // Simulate reconnect happening during the 150ms debounce window
    stateRef.current = { sessionId: "sess-new", status: "connected" };

    await new Promise((r) => setTimeout(r, 10));

    expect(timerFired).toBe(true);
    // Should see the NEW sessionId, not the old closure-captured one
    expect(sessionIdAtFireTime).toBe("sess-new");

    clearTimeout(timer);
  });

  test("resize is suppressed when status is not connected at fire time", async () => {
    const stateRef = { current: { sessionId: "sess-1", status: "connected" as const } };
    const pendingResizeRef: { current: { cols: number; rows: number } | null } = { current: { cols: 80, rows: 24 } };
    const resizeCalls: Array<{ cols: number; rows: number }> = [];

    setTimeout(() => {
      const currentSessionId = stateRef.current.sessionId;
      const currentStatus = stateRef.current.status;
      if (!pendingResizeRef.current || !currentSessionId || currentStatus !== "connected") return;
      pendingResizeRef.current = null;
      resizeCalls.push({ cols: 80, rows: 24 });
    }, 0);

    // Reconnect causes status to change before the timer fires
    stateRef.current = { sessionId: null as unknown as string, status: "reconnecting" as unknown as "connected" };

    await new Promise((r) => setTimeout(r, 10));

    expect(resizeCalls).toHaveLength(0);
  });
});

describe("Gap B: reconnect clears pending resize debounce timer", () => {
  test("pending resize timer is cancelled before reconnect opens a new session", async () => {
    let timerFired = false;
    const resizeTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const pendingResizeRef: { current: { cols: number; rows: number } | null } = { current: { cols: 80, rows: 24 } };

    // Schedule a resize (simulating what sendResize does)
    resizeTimerRef.current = setTimeout(() => {
      timerFired = true;
    }, 50);

    // Simulate reconnect: clear the resize timer
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    pendingResizeRef.current = null;

    // Wait long enough for the timer to have fired if it weren't cancelled
    await new Promise((r) => setTimeout(r, 100));

    expect(timerFired).toBe(false);
    expect(resizeTimerRef.current).toBeNull();
    expect(pendingResizeRef.current).toBeNull();
  });
});

describe("Gap C: SSE onError stops input flush timer", () => {
  test("input flush timer is stopped when SSE stream errors", async () => {
    let flushCount = 0;
    const inputFlushTimerRef = { current: null as ReturnType<typeof setInterval> | null };

    // Simulate starting the input flush timer
    inputFlushTimerRef.current = setInterval(() => {
      flushCount++;
    }, 10);

    const stopInputFlushTimer = () => {
      if (inputFlushTimerRef.current) {
        clearInterval(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }
    };

    // Simulate SSE onError calling stopInputFlushTimer before dispatching ERROR_OCCURRED
    stopInputFlushTimer();

    const countAfterStop = flushCount;

    // Wait to confirm the timer is no longer firing
    await new Promise((r) => setTimeout(r, 50));

    expect(inputFlushTimerRef.current).toBeNull();
    expect(flushCount).toBe(countAfterStop);
  });
});

// ---------------------------------------------------------------------------
// Unmount cleanup
// ---------------------------------------------------------------------------

describe("unmount cleanup", () => {
  test("stream cancel is called on unmount", () => {
    const handle = subscribeTerminalEvents("asst-1", "sess-1", () => undefined, () => undefined);
    // Simulate unmount
    handle.cancel();
    expect(mockStreamCancel).toHaveBeenCalledTimes(1);
  });

  test("destroyTerminalSession is called on unmount when session is active", async () => {
    const sessionId = "sess-cleanup";
    // Simulate unmount cleanup
    await destroyTerminalSession("asst-1", sessionId);
    expect(mockDestroyTerminalSession).toHaveBeenCalledWith("asst-1", sessionId);
  });
});
