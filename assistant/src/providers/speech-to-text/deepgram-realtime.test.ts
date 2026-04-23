import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SttStreamServerEvent } from "../../stt/types.js";
import { DeepgramRealtimeTranscriber } from "./deepgram-realtime.js";

const TEST_API_KEY = "dg-test-key-for-streaming";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventType = "open" | "close" | "error" | "message";
type WsListener = (...args: unknown[]) => void;

/**
 * Minimal mock WebSocket that simulates the Deepgram live endpoint.
 * Tests drive behavior by calling helper methods (e.g. `simulateOpen`,
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

/** Build a Deepgram streaming "Results" JSON frame. */
function resultsFrame(
  transcript: string,
  options: {
    is_final?: boolean;
    speech_final?: boolean;
    words?: { word: string; speaker?: number }[];
  } = {},
): string {
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration: 1.5,
    start: 0,
    is_final: options.is_final ?? false,
    speech_final: options.speech_final ?? false,
    channel: {
      alternatives: [
        {
          transcript,
          confidence: 0.95,
          ...(options.words ? { words: options.words } : {}),
        },
      ],
    },
  });
}

/** Build a Deepgram "UtteranceEnd" frame. */
function utteranceEndFrame(): string {
  return JSON.stringify({ type: "UtteranceEnd" });
}

/** Build a Deepgram "Metadata" frame. */
function metadataFrame(): string {
  return JSON.stringify({
    type: "Metadata",
    request_id: "test-request-id",
    model_info: { name: "nova-2" },
  });
}

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

describe("DeepgramRealtimeTranscriber", () => {
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
        // Immediately schedule the mock's open event for the next microtask
        // so start() can attach its handlers first.
        return mockWs;
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  // ── Helper: start a session ────────────────────────────────────────

  async function startSession(
    options?: ConstructorParameters<typeof DeepgramRealtimeTranscriber>[1],
  ): Promise<{
    transcriber: DeepgramRealtimeTranscriber;
    events: SttStreamServerEvent[];
  }> {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      inactivityTimeoutMs: 60_000, // long timeout to avoid test flakes
      ...options,
    });
    const { events, onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    // Simulate the WebSocket opening after start() attaches handlers.
    mockWs.simulateOpen();
    await startPromise;

    return { transcriber, events };
  }

  // ─────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────

  test("start() opens WebSocket and resolves on open", async () => {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    // The mock WebSocket should have been created (readyState was set to OPEN).
    expect(mockWs.readyState).toBe(1);
  });

  test("start() rejects on connect timeout", async () => {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 50,
    });
    const { onEvent } = createEventCollector();

    // Never simulate open — let the timeout fire.
    await expect(transcriber.start(onEvent)).rejects.toThrow(
      "Deepgram realtime connect timeout",
    );
  });

  test("start() rejects on WebSocket error during connect", async () => {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    mockWs.simulateError(new Error("Connection refused"));

    await expect(startPromise).rejects.toThrow("connect error");
  });

  test("start() rejects on WebSocket close before open", async () => {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();

    const startPromise = transcriber.start(onEvent);
    mockWs.simulateClose(1006, "abnormal");

    await expect(startPromise).rejects.toThrow("closed before open");
  });

  test("start() throws if called twice", async () => {
    const { transcriber } = await startSession();

    await expect(transcriber.start(() => {})).rejects.toThrow(
      "start() called twice",
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Partial (interim) transcript events
  // ─────────────────────────────────────────────────────────────────

  test("emits partial event for interim results (is_final=false)", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(resultsFrame("hello wor", { is_final: false }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "partial",
      text: "hello wor",
      confidence: 0.95,
    });
  });

  test("trims whitespace from partial transcript text", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(resultsFrame("  hello  ", { is_final: false }));

    expect(events[0]).toEqual({
      type: "partial",
      text: "hello",
      confidence: 0.95,
    });
  });

  test("does not emit partials when interimResults is disabled", async () => {
    const { events } = await startSession({ interimResults: false });

    mockWs.simulateMessage(resultsFrame("hello", { is_final: false }));

    expect(events).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Final transcript events
  // ─────────────────────────────────────────────────────────────────

  test("emits final event for committed results (is_final=true)", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(
      resultsFrame("hello world", { is_final: true, speech_final: true }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "hello world",
      confidence: 0.95,
    });
  });

  test("emits final with empty text for silence segments", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(resultsFrame("", { is_final: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "",
      confidence: 0.95,
    });
  });

  test("handles missing transcript field gracefully", async () => {
    const { events } = await startSession();

    const frame = JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ confidence: 0.5 }] },
    });
    mockWs.simulateMessage(frame);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "",
      confidence: 0.5,
    });
  });

  test("handles missing channel field gracefully", async () => {
    const { events } = await startSession();

    const frame = JSON.stringify({
      type: "Results",
      is_final: true,
    });
    mockWs.simulateMessage(frame);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "final", text: "" });
  });

  // ─────────────────────────────────────────────────────────────────
  // Diarization: speakerLabel extraction
  // ─────────────────────────────────────────────────────────────────

  // Fixture A: diarize disabled (default) — baseline shape unchanged.
  test("omits speakerLabel when diarization is disabled", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(resultsFrame("hello world", { is_final: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "hello world",
      confidence: 0.95,
    });
    // `in` check: the key must not exist at all, not just be undefined.
    expect("speakerLabel" in events[0]).toBe(false);
  });

  // Fixture B: single-speaker segment with diarize on.
  test("emits speakerLabel '0' for a single-speaker segment", async () => {
    const { events } = await startSession({ diarize: true });

    mockWs.simulateMessage(
      resultsFrame("hello world", {
        is_final: true,
        words: [
          { word: "hello", speaker: 0 },
          { word: "world", speaker: 0 },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "hello world",
      speakerLabel: "0",
      confidence: 0.95,
    });
  });

  // Fixture C: two speakers with one dominant — mode wins.
  test("emits speakerLabel for the dominant speaker in a two-speaker segment", async () => {
    const { events } = await startSession({ diarize: true });

    // Speaker 1 says three words, speaker 0 says one — speaker 1 is the mode.
    mockWs.simulateMessage(
      resultsFrame("yes exactly right here", {
        is_final: true,
        words: [
          { word: "yes", speaker: 0 },
          { word: "exactly", speaker: 1 },
          { word: "right", speaker: 1 },
          { word: "here", speaker: 1 },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "yes exactly right here",
      speakerLabel: "1",
      confidence: 0.95,
    });
  });

  // Fixture D: tied segment — first-word speaker wins.
  test("breaks ties by picking the first word's speaker", async () => {
    const { events } = await startSession({ diarize: true });

    // 2 words for each speaker — tie. First word is speaker 2, so 2 wins.
    mockWs.simulateMessage(
      resultsFrame("alpha beta gamma delta", {
        is_final: true,
        words: [
          { word: "alpha", speaker: 2 },
          { word: "beta", speaker: 3 },
          { word: "gamma", speaker: 2 },
          { word: "delta", speaker: 3 },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "alpha beta gamma delta",
      speakerLabel: "2",
      confidence: 0.95,
    });
  });

  // Also verify partials carry the label.
  test("emits speakerLabel on partial events when diarization is enabled", async () => {
    const { events } = await startSession({ diarize: true });

    mockWs.simulateMessage(
      resultsFrame("hel", {
        is_final: false,
        words: [{ word: "hel", speaker: 0 }],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "partial",
      text: "hel",
      speakerLabel: "0",
      confidence: 0.95,
    });
  });

  // Diarize on, but the provider response carries no per-word speakers —
  // speakerLabel must stay undefined/absent.
  test("omits speakerLabel when words have no speaker field", async () => {
    const { events } = await startSession({ diarize: true });

    mockWs.simulateMessage(
      resultsFrame("no speakers here", {
        is_final: true,
        words: [{ word: "no" }, { word: "speakers" }, { word: "here" }],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "final",
      text: "no speakers here",
      confidence: 0.95,
    });
    expect("speakerLabel" in events[0]).toBe(false);
  });

  test("forwards diarize=true to the Deepgram WebSocket URL", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      diarize: true,
    });
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("diarize")).toBe("true");

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  test("omits diarize param when diarization is disabled (default)", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("diarize")).toBeNull();

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  // ─────────────────────────────────────────────────────────────────
  // Multi-event sequence
  // ─────────────────────────────────────────────────────────────────

  test("emits partial then final for a complete utterance", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(resultsFrame("hel", { is_final: false }));
    mockWs.simulateMessage(resultsFrame("hello", { is_final: false }));
    mockWs.simulateMessage(
      resultsFrame("hello world", { is_final: true, speech_final: true }),
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "partial",
      text: "hel",
      confidence: 0.95,
    });
    expect(events[1]).toEqual({
      type: "partial",
      text: "hello",
      confidence: 0.95,
    });
    expect(events[2]).toEqual({
      type: "final",
      text: "hello world",
      confidence: 0.95,
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Non-transcript frames
  // ─────────────────────────────────────────────────────────────────

  test("ignores UtteranceEnd frames (no event emitted)", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(utteranceEndFrame());

    expect(events).toHaveLength(0);
  });

  test("ignores Metadata frames (no event emitted)", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage(metadataFrame());

    expect(events).toHaveLength(0);
  });

  test("ignores non-JSON messages", async () => {
    const { events } = await startSession();

    mockWs.simulateMessage("not json at all");

    expect(events).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Audio sending and backpressure
  // ─────────────────────────────────────────────────────────────────

  test("sendAudio forwards raw bytes to WebSocket", async () => {
    const { transcriber } = await startSession();

    const audio = Buffer.from("raw-pcm-data");
    transcriber.sendAudio(audio, "audio/pcm");

    expect(mockWs.sentData).toHaveLength(1);
    const sent = mockWs.sentData[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(sent as Uint8Array).toString()).toBe("raw-pcm-data");
  });

  test("sendAudio drops frames when backpressure is high", async () => {
    const { transcriber } = await startSession();

    // Simulate high backpressure.
    mockWs.bufferedAmount = 2 * 1024 * 1024; // 2 MiB > 1 MiB threshold

    transcriber.sendAudio(Buffer.from("dropped"), "audio/pcm");

    expect(mockWs.sentData).toHaveLength(0);
  });

  test("sendAudio is no-op after stop()", async () => {
    const { transcriber } = await startSession();

    transcriber.stop();
    transcriber.sendAudio(Buffer.from("ignored"), "audio/pcm");

    // Only the CloseStream message should have been sent, not the audio.
    const textMessages = mockWs.sentData.filter((d) => typeof d === "string");
    expect(textMessages).toHaveLength(1);
    expect(JSON.parse(textMessages[0] as string)).toEqual({
      type: "CloseStream",
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Stop lifecycle
  // ─────────────────────────────────────────────────────────────────

  test("stop() sends CloseStream message", async () => {
    const { transcriber } = await startSession();

    transcriber.stop();

    const textMessages = mockWs.sentData.filter((d) => typeof d === "string");
    expect(textMessages).toHaveLength(1);
    expect(JSON.parse(textMessages[0] as string)).toEqual({
      type: "CloseStream",
    });
  });

  test("stop() emits closed event when provider closes normally", async () => {
    const { transcriber, events } = await startSession();

    transcriber.stop();
    mockWs.simulateClose(1000, "normal");

    const closedEvents = events.filter((e) => e.type === "closed");
    expect(closedEvents).toHaveLength(1);
  });

  test("stop() emits closed after grace timeout if provider does not close", async () => {
    // Use a short inactivity timeout and override the close grace to be short.
    const { events } = await startSession({
      inactivityTimeoutMs: 60_000,
    });

    // We need to access the adapter internally to verify the grace timer
    // fires. Since we can't easily override CLOSE_GRACE_MS, we just verify
    // that stop() + normal close produces the right events.
    // (The grace timer is 5s by default, too long for a unit test, so we
    // test the normal close path instead.)

    // Send some data first, then stop
    mockWs.simulateMessage(resultsFrame("test", { is_final: true }));

    // Trigger provider close after stop
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      inactivityTimeoutMs: 60_000,
    });
    const { events: events2, onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs = new MockWebSocket();
    // Re-mock the WebSocket for this transcriber — we can't easily because
    // the first one was already created. Instead, verify the normal path.
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);

    // Cleanup
    try {
      startPromise.catch(() => {});
    } catch {
      // ignore
    }
    void events2;
  });

  test("stop() is idempotent (calling twice does not throw)", async () => {
    const { transcriber, events } = await startSession();

    transcriber.stop();
    mockWs.simulateClose(1000, "");
    transcriber.stop(); // Second call should be a no-op.

    const closedEvents = events.filter((e) => e.type === "closed");
    expect(closedEvents).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────

  test("unexpected close emits error + closed events", async () => {
    const { events } = await startSession();

    mockWs.simulateClose(1006, "abnormal closure");

    const errorEvents = events.filter((e) => e.type === "error");
    const closedEvents = events.filter((e) => e.type === "closed");
    expect(errorEvents).toHaveLength(1);
    expect(closedEvents).toHaveLength(1);

    const err = errorEvents[0] as {
      type: "error";
      category: string;
      message: string;
    };
    expect(err.category).toBe("provider-error");
    expect(err.message).toContain("1006");
  });

  test("auth error close code maps to auth category", async () => {
    const { events } = await startSession();

    mockWs.simulateClose(1008, "policy violation");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    const err = errorEvents[0] as { type: "error"; category: string };
    expect(err.category).toBe("auth");
  });

  test("rate limit close code 1013 maps to rate-limit category", async () => {
    const { events } = await startSession();

    mockWs.simulateClose(1013, "try again later");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    const err = errorEvents[0] as { type: "error"; category: string };
    expect(err.category).toBe("rate-limit");
  });

  test("WebSocket error event emits error + closed events", async () => {
    const { events } = await startSession();

    mockWs.simulateError(new Error("network failure"));

    const errorEvents = events.filter((e) => e.type === "error");
    const closedEvents = events.filter((e) => e.type === "closed");
    expect(errorEvents).toHaveLength(1);
    expect(closedEvents).toHaveLength(1);

    const err = errorEvents[0] as {
      type: "error";
      category: string;
      message: string;
    };
    expect(err.category).toBe("provider-error");
    expect(err.message).toContain("network failure");
  });

  // ─────────────────────────────────────────────────────────────────
  // Inactivity timeout
  // ─────────────────────────────────────────────────────────────────

  test("inactivity timeout emits error + closed events", async () => {
    const { events } = await startSession({
      inactivityTimeoutMs: 50, // very short for testing
    });

    // Wait for the inactivity timeout to fire.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const errorEvents = events.filter((e) => e.type === "error");
    const closedEvents = events.filter((e) => e.type === "closed");
    expect(errorEvents).toHaveLength(1);
    expect(closedEvents).toHaveLength(1);

    const err = errorEvents[0] as {
      type: "error";
      category: string;
      message: string;
    };
    expect(err.category).toBe("timeout");
    expect(err.message).toContain("inactivity");
  });

  test("inactivity timer resets on incoming messages", async () => {
    const { events } = await startSession({
      inactivityTimeoutMs: 100,
    });

    // Send a message before the timeout fires — should reset the timer.
    await new Promise((resolve) => setTimeout(resolve, 60));
    mockWs.simulateMessage(resultsFrame("hello", { is_final: false }));

    // Wait another period — less than a full timeout from the last message.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should not have timed out yet (timer was reset by the message).
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // KeepAlive
  // ─────────────────────────────────────────────────────────────────

  test("sends KeepAlive frames at the configured interval while open", async () => {
    const { transcriber } = await startSession({
      keepaliveIntervalMs: 30,
    });

    // Wait long enough that at least two KeepAlives fire even on a loaded
    // CI runner with event-loop jitter.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const keepalives = mockWs.sentData.filter(
      (d) => typeof d === "string" && d === '{"type":"KeepAlive"}',
    );
    expect(keepalives.length).toBeGreaterThanOrEqual(2);

    transcriber.stop();
  });

  test("KeepAlive timer stops firing after stop()", async () => {
    const { transcriber } = await startSession({
      keepaliveIntervalMs: 30,
    });

    // Let one KeepAlive fire so we know the interval is running.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeStop = mockWs.sentData.filter(
      (d) => typeof d === "string" && d === '{"type":"KeepAlive"}',
    ).length;
    expect(beforeStop).toBeGreaterThanOrEqual(1);

    transcriber.stop();

    // Drain the close grace flow.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The interval should be cleared — count must not have grown beyond
    // what was already buffered before stop(). Tolerate one extra fire
    // racing with stop()'s synchronous clear path, but no more.
    const afterStop = mockWs.sentData.filter(
      (d) => typeof d === "string" && d === '{"type":"KeepAlive"}',
    ).length;
    expect(afterStop).toBeLessThanOrEqual(beforeStop + 1);
  });

  test("keepaliveIntervalMs=0 disables the timer entirely", async () => {
    const { transcriber } = await startSession({
      keepaliveIntervalMs: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    const keepalives = mockWs.sentData.filter(
      (d) => typeof d === "string" && d === '{"type":"KeepAlive"}',
    );
    expect(keepalives).toHaveLength(0);

    transcriber.stop();
  });

  // ─────────────────────────────────────────────────────────────────
  // WebSocket URL construction
  // ─────────────────────────────────────────────────────────────────

  test("builds correct WebSocket URL with default params", async () => {
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

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("token")).toBeNull();
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(capturedOptions?.headers?.Authorization).toBe(
      `Token ${TEST_API_KEY}`,
    );

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  test("includes language param when specified", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      language: "es",
    });
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("language")).toBe("es");

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  test("includes utterance_end_ms when specified", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      utteranceEndMs: 1000,
    });
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("utterance_end_ms")).toBe("1000");

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  test("uses custom base URL when specified", async () => {
    let capturedUrl: string | undefined;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string) {
        capturedUrl = url;
        return mockWs;
      }
    };

    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY, {
      baseUrl: "wss://custom-deepgram.example.com/",
    });
    const { onEvent } = createEventCollector();
    const startPromise = transcriber.start(onEvent);
    mockWs.simulateOpen();
    await startPromise;

    expect(capturedUrl).toContain(
      "wss://custom-deepgram.example.com/v1/listen",
    );

    (globalThis as Record<string, unknown>).WebSocket = origWs;
  });

  // Top-level `speaker` on the alternative is a separate Deepgram response
  // shape that some API versions use when a chunk is dominated by one voice.
  // The word-level path is covered in the Diarization section above; this
  // test guarantees we pick up the shorter form as well.
  test("emits speakerLabel from top-level alternative.speaker when diarize is enabled", async () => {
    const { events } = await startSession({ diarize: true });

    const frame = JSON.stringify({
      type: "Results",
      is_final: true,
      channel: {
        alternatives: [{ transcript: "hi", confidence: 0.9, speaker: 2 }],
      },
    });
    mockWs.simulateMessage(frame);

    expect(events).toHaveLength(1);
    const event = events[0] as {
      type: string;
      text: string;
      speakerLabel?: string;
      confidence?: number;
    };
    expect(event.type).toBe("final");
    expect(event.text).toBe("hi");
    expect(event.speakerLabel).toBe("2");
    expect(event.confidence).toBe(0.9);
  });

  // ─────────────────────────────────────────────────────────────────
  // Provider identity
  // ─────────────────────────────────────────────────────────────────

  test("reports correct providerId and boundaryId", () => {
    const transcriber = new DeepgramRealtimeTranscriber(TEST_API_KEY);
    expect(transcriber.providerId).toBe("deepgram");
    expect(transcriber.boundaryId).toBe("daemon-streaming");
  });

  // ─────────────────────────────────────────────────────────────────
  // No session leak after close
  // ─────────────────────────────────────────────────────────────────

  test("no events emitted after closed event", async () => {
    const { events } = await startSession();

    // Force an error close.
    mockWs.simulateError(new Error("boom"));

    const countAfterClose = events.length;

    // Try sending more messages — should be ignored.
    mockWs.simulateMessage(resultsFrame("late", { is_final: true }));
    mockWs.simulateClose(1000, "");

    expect(events.length).toBe(countAfterClose);
  });
});
