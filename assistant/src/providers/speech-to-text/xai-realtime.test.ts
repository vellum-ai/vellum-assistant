import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SttStreamServerEvent } from "../../stt/types.js";
import { XAIRealtimeTranscriber } from "./xai-realtime.js";

const TEST_API_KEY = "xai-test-key-for-streaming";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventType = "open" | "close" | "error" | "message";
type WsListener = (...args: unknown[]) => void;

/**
 * Minimal mock WebSocket that simulates the xAI live endpoint. Tests
 * drive behavior by calling helper methods (e.g. `simulateOpen`,
 * `simulateMessage`).
 */
class MockWebSocket {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;

  /** All data sent via `.send()`. */
  sentData: (string | Uint8Array)[] = [];

  /** Whether `.close()` was called. */
  closeCalled = false;
  closeCode?: number;
  closeReason?: string;

  private listeners = new Map<WsEventType, WsListener[]>();

  addEventListener(type: WsEventType, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: unknown): void {
    const list = this.listeners.get(type as WsEventType);
    if (!list) return;
    const idx = list.indexOf(listener as WsListener);
    if (idx !== -1) list.splice(idx, 1);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.sentData.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalled = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  // ── Test helpers ──────────────────────────────────────────────────

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    for (const l of this.listeners.get("open") ?? []) l();
  }

  simulateMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) l({ code, reason });
  }

  simulateError(err: unknown): void {
    for (const l of this.listeners.get("error") ?? []) l(err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an xAI `transcript.partial` JSON frame. */
function partialFrame(
  text: string,
  options: {
    is_final?: boolean;
    words?: { word: string; speaker?: number }[];
  } = {},
): string {
  return JSON.stringify({
    type: "transcript.partial",
    is_final: options.is_final ?? false,
    text,
    ...(options.words ? { words: options.words } : {}),
  });
}

/** Build an xAI `transcript.done` JSON frame. */
function doneFrame(
  text: string,
  options: { words?: { word: string; speaker?: number }[] } = {},
): string {
  return JSON.stringify({
    type: "transcript.done",
    text,
    ...(options.words ? { words: options.words } : {}),
  });
}

/** Build an xAI `error` JSON frame. */
function errorFrame(message: string): string {
  return JSON.stringify({ type: "error", message });
}

/** Frame xAI sends once the session is ready to accept audio. */
const CREATED_FRAME = JSON.stringify({ type: "transcript.created" });

/** Collect all events emitted during a test. */
function createEventCollector(): {
  events: SttStreamServerEvent[];
  onEvent: (event: SttStreamServerEvent) => void;
} {
  const events: SttStreamServerEvent[] = [];
  return {
    events,
    onEvent: (event: SttStreamServerEvent) => events.push(event),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("XAIRealtimeTranscriber", () => {
  let mockWs: MockWebSocket;
  let originalWebSocket: unknown;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;

    // Replace global WebSocket with a factory that returns our mock.
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(
        _url: string,
        _options?: { headers?: Record<string, string> },
      ) {
        return mockWs;
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  // ── Helper: start a session ────────────────────────────────────────

  async function startSession(
    options?: ConstructorParameters<typeof XAIRealtimeTranscriber>[1],
  ): Promise<{
    transcriber: XAIRealtimeTranscriber;
    events: SttStreamServerEvent[];
  }> {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      inactivityTimeoutMs: 60_000, // long timeout to avoid test flakes
      ...options,
    });
    const { events, onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    mockWs.simulateMessage(CREATED_FRAME);
    await startPromise;

    return { transcriber, events };
  }

  // ─────────────────────────────────────────────────────────────────
  // Connect success (URL + Authorization header)
  // ─────────────────────────────────────────────────────────────────

  test("start() opens WebSocket with correct URL params and Authorization header", async () => {
    let capturedUrl: string | undefined;
    let capturedOptions: { headers?: Record<string, string> } | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        capturedUrl = url;
        capturedOptions = options;
        return mockWs;
      }
    };

    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    mockWs.simulateMessage(CREATED_FRAME);
    await startPromise;

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("api.x.ai");
    expect(url.pathname).toBe("/v1/stt");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("encoding")).toBe("pcm");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(capturedOptions?.headers?.Authorization).toBe(
      `Bearer ${TEST_API_KEY}`,
    );

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  // ─────────────────────────────────────────────────────────────────
  // Partial (interim) events
  // ─────────────────────────────────────────────────────────────────

  test("emits partial event for transcript.partial with is_final=false", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(partialFrame("hello wor", { is_final: false }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "partial", text: "hello wor" });
  });

  // ─────────────────────────────────────────────────────────────────
  // Interim-final events
  // ─────────────────────────────────────────────────────────────────

  test("emits final event for transcript.partial with is_final=true", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(partialFrame("hello world", { is_final: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "final", text: "hello world" });
  });

  // ─────────────────────────────────────────────────────────────────
  // Done event
  // ─────────────────────────────────────────────────────────────────

  test("emits final event for transcript.done", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(doneFrame("all done now"));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "final", text: "all done now" });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error frame — socket stays open
  // ─────────────────────────────────────────────────────────────────

  test("emits error event for xAI error frame without closing socket", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(errorFrame("transient provider hiccup"));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      category: "provider-error",
      message: "transient provider hiccup",
    });

    // Socket must stay open per xAI docs — no `closed` event.
    expect(events.filter((e) => e.type === "closed")).toHaveLength(0);
    expect(mockWs.closeCalled).toBe(false);

    // Confirm subsequent transcript frames still flow.
    mockWs.simulateMessage(partialFrame("still here", { is_final: true }));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "final", text: "still here" });
  });

  // ─────────────────────────────────────────────────────────────────
  // Audio backpressure
  // ─────────────────────────────────────────────────────────────────

  test("sendAudio drops frames when bufferedAmount exceeds MAX_BUFFERED_AMOUNT", async () => {
    const { transcriber } = await startSession();

    // Simulate high backpressure.
    mockWs.bufferedAmount = 2 * 1024 * 1024; // 2 MiB > 1 MiB threshold

    transcriber.sendAudio(Buffer.from("dropped"), "audio/pcm");

    expect(mockWs.sentData).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // stop() sends audio.done text frame
  // ─────────────────────────────────────────────────────────────────

  test("stop() sends audio.done as text frame and emits closed on socket close", async () => {
    const { transcriber, events } = await startSession();

    transcriber.stop();

    // audio.done must be a text frame, not binary.
    const textMessages = mockWs.sentData.filter((d) => typeof d === "string");
    expect(textMessages).toHaveLength(1);
    expect(textMessages[0]).toBe('{"type":"audio.done"}');
    expect(JSON.parse(textMessages[0] as string)).toEqual({
      type: "audio.done",
    });

    mockWs.simulateClose(1000, "normal");

    const closedEvents = events.filter((e) => e.type === "closed");
    expect(closedEvents).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Diarize path — URL query + speakerLabel aggregation
  // ─────────────────────────────────────────────────────────────────

  test("diarize=true forwards URL param and aggregates speakerLabel with mode + first-word tiebreaker", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      diarize: true,
      inactivityTimeoutMs: 60_000,
    });
    const { events, onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    mockWs.simulateMessage(CREATED_FRAME);
    await startPromise;

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("diarize")).toBe("true");

    // speaker tags [0, 0, 1, 0] — mode is 0 (3 occurrences vs 1).
    mockWs.simulateMessage(
      partialFrame("a b c d", {
        is_final: true,
        words: [
          { word: "a", speaker: 0 },
          { word: "b", speaker: 0 },
          { word: "c", speaker: 1 },
          { word: "d", speaker: 0 },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "a b c d",
      speakerLabel: "0",
    });

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  // ─────────────────────────────────────────────────────────────────
  // Connect timeout
  // ─────────────────────────────────────────────────────────────────

  test("start() rejects on connect timeout when open never fires", async () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 50,
    });
    const { onEvent } = createEventCollector();

    // Never simulate open — let the timeout fire.
    await expect(transcriber.start(onEvent)).rejects.toThrow(
      "xAI realtime connect timeout",
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Provider identity (sanity check)
  // ─────────────────────────────────────────────────────────────────

  test("reports correct providerId and boundaryId", () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY);
    expect(transcriber.providerId).toBe("xai");
    expect(transcriber.boundaryId).toBe("daemon-streaming");
  });

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle: stop() cancels inactivity timer so the CLOSE_GRACE
  // window can't emit a spurious timeout error.
  // ─────────────────────────────────────────────────────────────────

  test("stop() cancels inactivity timer so the close-grace window can't emit a timeout error", async () => {
    const { transcriber, events } = await startSession({
      // Short inactivity timeout — would fire within the CLOSE_GRACE
      // window if stop() failed to cancel it.
      inactivityTimeoutMs: 30,
    });

    transcriber.stop();

    // Wait longer than the inactivity window but less than CLOSE_GRACE
    // (5s) to confirm the timer doesn't fire during the grace period.
    await new Promise((r) => setTimeout(r, 80));

    // No timeout-category error must have been emitted — stop() is
    // an intentional teardown.
    const timeoutErrors = events.filter(
      (e) => e.type === "error" && e.category === "timeout",
    );
    expect(timeoutErrors).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle: connect-phase listeners are removed after the Promise
  // settles — they must not fire alongside session-lifetime handlers.
  // ─────────────────────────────────────────────────────────────────

  test("connect-phase listeners are detached after start() resolves", async () => {
    const { events } = await startSession();

    // After the connect Promise resolves, only the session handlers
    // (attachSessionHandlers) should be attached. A stray connect-phase
    // `onClose` listener would also fire on simulateClose and could
    // reject a (dead) Promise or run stale cleanup code.
    //
    // We can't introspect the mock's listener map via the public API,
    // but we can verify the session-level handler is the only one that
    // reacts: simulating close under `stopping=true` and code=1000 must
    // produce exactly one closed event, and simulating a transcript
    // frame before that must behave normally.
    mockWs.simulateMessage(partialFrame("ok", { is_final: true }));
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);

    // Drive a direct inspection: the MockWebSocket exposes a private
    // listeners map; asserting size === 1 for each type after start()
    // confirms connect-phase listeners were removed.
    const listenersByType = (
      mockWs as unknown as { listeners: Map<string, unknown[]> }
    ).listeners;
    expect(listenersByType.get("open")?.length ?? 0).toBe(0);
    expect(listenersByType.get("error")?.length ?? 0).toBe(1);
    expect(listenersByType.get("close")?.length ?? 0).toBe(1);
    expect(listenersByType.get("message")?.length ?? 0).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle: connect-phase error/close paths null out this.ws so
  // a retry can reuse the same transcriber instance.
  // ─────────────────────────────────────────────────────────────────

  test("start() allows retry after connect-phase close rejects", async () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 1_000,
    });
    const { onEvent } = createEventCollector();

    // First attempt: socket closes before opening.
    const firstAttempt = transcriber.start(onEvent);
    mockWs.simulateClose(4001, "unauthorized");
    await expect(firstAttempt).rejects.toThrow(
      /xAI WebSocket closed before handshake/,
    );

    // Second attempt with a fresh mock — must not throw
    // "start() called twice" because the first attempt null'd out
    // this.ws.
    mockWs = new MockWebSocket();
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(
        _url: string,
        _options?: { headers?: Record<string, string> },
      ) {
        return mockWs;
      }
    };

    const secondAttempt = transcriber.start(onEvent);
    mockWs.simulateOpen();
    mockWs.simulateMessage(CREATED_FRAME);
    await expect(secondAttempt).resolves.toBeUndefined();
  });

  test("start() allows retry after connect-phase error rejects", async () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 1_000,
    });
    const { onEvent } = createEventCollector();

    // First attempt: transport-level error before open.
    const firstAttempt = transcriber.start(onEvent);
    mockWs.simulateError(new Error("ECONNREFUSED"));
    await expect(firstAttempt).rejects.toThrow(/xAI realtime connect error/);

    // Second attempt — instance must be reusable.
    mockWs = new MockWebSocket();
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(
        _url: string,
        _options?: { headers?: Record<string, string> },
      ) {
        return mockWs;
      }
    };

    const secondAttempt = transcriber.start(onEvent);
    mockWs.simulateOpen();
    mockWs.simulateMessage(CREATED_FRAME);
    await expect(secondAttempt).resolves.toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────
  // Handshake: start() does NOT resolve on WS `open` alone — it waits
  // for xAI's `transcript.created` frame so early sendAudio() calls
  // can't be dropped before the session is ready.
  // ─────────────────────────────────────────────────────────────────

  test("start() waits for transcript.created before resolving", async () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 1_000,
      inactivityTimeoutMs: 60_000,
    });
    const { onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);

    // Only `open` fires — start() must not resolve yet.
    mockWs.simulateOpen();
    let resolved = false;
    startPromise.then(
      () => {
        resolved = true;
      },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // `transcript.created` arrives — start() resolves.
    mockWs.simulateMessage(CREATED_FRAME);
    await expect(startPromise).resolves.toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────
  // Close-race: a close event that arrives between WS open and
  // `transcript.created` must be handled (rejecting start()), not
  // dropped into a listener gap.
  // ─────────────────────────────────────────────────────────────────

  test("start() rejects when close fires between open and transcript.created", async () => {
    const transcriber = new XAIRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 1_000,
    });
    const { onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    // Close arrives before transcript.created — must still reject
    // rather than silently hanging the handshake.
    mockWs.simulateClose(1011, "server error");

    await expect(startPromise).rejects.toThrow(
      /xAI WebSocket closed before handshake/,
    );
  });
});
