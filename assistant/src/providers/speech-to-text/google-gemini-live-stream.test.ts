import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SttStreamServerEvent } from "../../stt/types.js";
import { GoogleGeminiLiveStreamingTranscriber } from "./google-gemini-live-stream.js";

const TEST_API_KEY = "google-live-test-key";

// ---------------------------------------------------------------------------
// Mock Live session
// ---------------------------------------------------------------------------

interface LiveCallbacksForTests {
  onopen?: () => void;
  onmessage: (msg: unknown) => void;
  onerror?: (ev: unknown) => void;
  onclose?: (ev: { code: number; reason: string }) => void;
}

interface CapturedConnect {
  params: {
    model: string;
    config?: {
      responseModalities?: unknown;
      inputAudioTranscription?: unknown;
      systemInstruction?: unknown;
    };
    callbacks: LiveCallbacksForTests;
  };
  session: MockLiveSession;
}

/**
 * Minimal mock of the Live API Session returned by `ai.live.connect`.
 * Tests drive behavior via the captured `callbacks` on the connect
 * invocation plus helper methods (`simulateMessage`, `simulateClose`,
 * `simulateError`).
 */
class MockLiveSession {
  sentInputs: unknown[] = [];
  closeCalled = false;
  private readonly callbacks: LiveCallbacksForTests;

  constructor(callbacks: LiveCallbacksForTests) {
    this.callbacks = callbacks;
  }

  sendRealtimeInput(params: unknown): void {
    this.sentInputs.push(params);
  }

  sendClientContent(_params: unknown): void {
    // Not used by the adapter but present to satisfy structural typing.
  }

  close(): void {
    this.closeCalled = true;
  }

  // ── Test helpers ──────────────────────────────────────────────────

  simulateMessage(msg: Record<string, unknown>): void {
    this.callbacks.onmessage(msg);
  }

  simulateClose(code = 1000, reason = ""): void {
    this.callbacks.onclose?.({ code, reason });
  }

  simulateError(ev: unknown): void {
    this.callbacks.onerror?.(ev);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Install a mock GoogleGenAI constructor on the module's `client` field
 * before `start()` runs. We patch the adapter's private client after
 * construction to a minimal object that exposes `live.connect()`.
 */
function installMockClient(
  transcriber: GoogleGeminiLiveStreamingTranscriber,
  opts: {
    /** Whether to invoke `onopen` on the next microtask. Default: true. */
    autoOpen?: boolean;
    /** If provided, delay the mock's `connect` resolution by N ms. */
    resolveDelayMs?: number;
  } = {},
): {
  capturedCalls: CapturedConnect[];
} {
  const capturedCalls: CapturedConnect[] = [];
  const autoOpen = opts.autoOpen ?? true;

  const mockLive = {
    connect: (params: CapturedConnect["params"]): Promise<MockLiveSession> => {
      const session = new MockLiveSession(params.callbacks);
      capturedCalls.push({ params, session });

      // Fire onopen on the next microtask by default.
      if (autoOpen) {
        queueMicrotask(() => {
          params.callbacks.onopen?.();
        });
      }

      if (opts.resolveDelayMs !== undefined) {
        return new Promise((resolve) =>
          setTimeout(() => resolve(session), opts.resolveDelayMs),
        );
      }
      return Promise.resolve(session);
    },
  };

  (transcriber as unknown as { client: { live: typeof mockLive } }).client = {
    live: mockLive,
  };

  return { capturedCalls };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GoogleGeminiLiveStreamingTranscriber", () => {
  let transcriber: GoogleGeminiLiveStreamingTranscriber;

  beforeEach(() => {
    transcriber = new GoogleGeminiLiveStreamingTranscriber(TEST_API_KEY, {
      // Long inactivity timeout to avoid test flakes.
      inactivityTimeoutMs: 60_000,
    });
  });

  afterEach(() => {
    // Best-effort stop in case a test forgot.
    try {
      transcriber.stop();
    } catch {
      // ignore
    }
  });

  // ── Helper: start a session ────────────────────────────────────────

  async function startSession(
    options?: {
      transcriberOptions?: ConstructorParameters<
        typeof GoogleGeminiLiveStreamingTranscriber
      >[1];
      installOptions?: Parameters<typeof installMockClient>[1];
    },
  ): Promise<{
    transcriber: GoogleGeminiLiveStreamingTranscriber;
    session: MockLiveSession;
    events: SttStreamServerEvent[];
    capturedCalls: CapturedConnect[];
  }> {
    const t = options?.transcriberOptions
      ? new GoogleGeminiLiveStreamingTranscriber(
          TEST_API_KEY,
          options.transcriberOptions,
        )
      : transcriber;
    const { capturedCalls } = installMockClient(t, options?.installOptions);
    const { events, onEvent } = createEventCollector();
    await t.start(onEvent);
    const session = capturedCalls[0]?.session;
    if (!session) throw new Error("No connect call captured");
    return { transcriber: t, session, events, capturedCalls };
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  test("start() resolves after onopen fires", async () => {
    installMockClient(transcriber);
    const { onEvent } = createEventCollector();
    await transcriber.start(onEvent);
    // No error = success
  });

  test("start() rejects after connectTimeoutMs if open never fires", async () => {
    const t = new GoogleGeminiLiveStreamingTranscriber(TEST_API_KEY, {
      connectTimeoutMs: 30,
    });
    installMockClient(t, { autoOpen: false });

    const { onEvent } = createEventCollector();
    await expect(t.start(onEvent)).rejects.toThrow(
      "Gemini Live connect timeout",
    );
  });

  test("start() throws if called twice", async () => {
    const { transcriber: t } = await startSession();
    await expect(t.start(() => {})).rejects.toThrow("start() called twice");
  });

  test("sendAudio() is a no-op before start() resolves (session not yet set)", () => {
    installMockClient(transcriber);
    // Do not await start() — session is null.
    transcriber.sendAudio(Buffer.from([1, 2, 3]), "audio/pcm;rate=16000");
    // No throw; nothing else observable since no session was created yet.
  });

  test("stop() is idempotent", async () => {
    const { transcriber: t, session, events } = await startSession();
    t.stop();
    session.simulateClose(1000, "normal");
    t.stop(); // Second call should be a no-op.

    const closedEvents = events.filter((e) => e.type === "closed");
    expect(closedEvents).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Setup config
  // ─────────────────────────────────────────────────────────────────

  test("connect() is called with TEXT-only modality and inputAudioTranscription enabled", async () => {
    const { capturedCalls } = await startSession();

    expect(capturedCalls).toHaveLength(1);
    const params = capturedCalls[0].params;
    expect(params.model).toBe("gemini-live-2.5-flash-preview");
    expect(params.config?.responseModalities).toEqual(["TEXT"]);
    expect(params.config?.inputAudioTranscription).toEqual({});
    expect(typeof params.config?.systemInstruction).toBe("string");
  });

  // ─────────────────────────────────────────────────────────────────
  // Audio forwarding
  // ─────────────────────────────────────────────────────────────────

  test("sendAudio() forwards base64-encoded PCM with the provided mimeType", async () => {
    const { transcriber: t, session } = await startSession();

    const audio = Buffer.from([1, 2, 3]);
    t.sendAudio(audio, "audio/pcm;rate=16000");

    expect(session.sentInputs).toHaveLength(1);
    const input = session.sentInputs[0] as {
      audio?: { data: string; mimeType: string };
    };
    expect(input.audio?.data).toBe(audio.toString("base64"));
    expect(input.audio?.mimeType).toBe("audio/pcm;rate=16000");
  });

  test("sendAudio() normalizes bare audio/pcm to include the configured sample rate", async () => {
    const { transcriber: t, session } = await startSession({
      transcriberOptions: {
        pcmSampleRate: 24_000,
        inactivityTimeoutMs: 60_000,
      },
    });

    t.sendAudio(Buffer.from([9, 9, 9]), "audio/pcm");

    const input = session.sentInputs[0] as {
      audio?: { data: string; mimeType: string };
    };
    expect(input.audio?.mimeType).toBe("audio/pcm;rate=24000");
  });

  test("sendAudio() passes non-PCM mime types through unchanged", async () => {
    const { transcriber: t, session } = await startSession();

    t.sendAudio(Buffer.from([1, 2]), "audio/webm");

    const input = session.sentInputs[0] as {
      audio?: { data: string; mimeType: string };
    };
    expect(input.audio?.mimeType).toBe("audio/webm");
  });

  // ─────────────────────────────────────────────────────────────────
  // Transcription events: partial → final
  // ─────────────────────────────────────────────────────────────────

  test("emits partial events for accumulated inputTranscription text", async () => {
    const { session, events } = await startSession();

    session.simulateMessage({
      serverContent: {
        inputTranscription: { text: "hello" },
      },
    });
    session.simulateMessage({
      serverContent: {
        inputTranscription: { text: " world" },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "partial", text: "hello" });
    expect(events[1]).toEqual({ type: "partial", text: "hello world" });
  });

  test("emits final event on generationComplete and resets accumulator", async () => {
    const { session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "hello" } },
    });
    session.simulateMessage({
      serverContent: { inputTranscription: { text: " world" } },
    });
    session.simulateMessage({
      serverContent: { generationComplete: true },
    });

    expect(events).toEqual([
      { type: "partial", text: "hello" },
      { type: "partial", text: "hello world" },
      { type: "final", text: "hello world" },
    ]);

    // New turn starts fresh.
    session.simulateMessage({
      serverContent: { inputTranscription: { text: "again" } },
    });
    expect(events[events.length - 1]).toEqual({
      type: "partial",
      text: "again",
    });
  });

  test("emits final event on turnComplete as well as generationComplete", async () => {
    const { session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "done" } },
    });
    session.simulateMessage({
      serverContent: { turnComplete: true },
    });

    expect(events.filter((e) => e.type === "final")).toEqual([
      { type: "final", text: "done" },
    ]);
  });

  test("dedupes repeated partials when the transcription text does not change", async () => {
    const { session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "hello" } },
    });
    // Same text repeated — no new partial.
    session.simulateMessage({
      serverContent: { inputTranscription: { text: "" } },
    });
    session.simulateMessage({
      serverContent: { inputTranscription: {} },
    });

    const partials = events.filter((e) => e.type === "partial");
    expect(partials).toHaveLength(1);
    expect(partials[0]).toEqual({ type: "partial", text: "hello" });
  });

  test("ignores serverContent.modelTurn payloads that don't carry inputTranscription", async () => {
    const { session, events } = await startSession();

    session.simulateMessage({
      serverContent: {
        modelTurn: { parts: [{ text: "I'm staying silent" }] },
      },
    });

    expect(events).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Stop lifecycle
  // ─────────────────────────────────────────────────────────────────

  test("stop() signals audioStreamEnd and emits final + closed after provider closes", async () => {
    const { transcriber: t, session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "goodbye" } },
    });

    t.stop();

    const endSignal = session.sentInputs.find(
      (input) => (input as { audioStreamEnd?: boolean }).audioStreamEnd,
    );
    expect(endSignal).toEqual({ audioStreamEnd: true });

    // Provider completes the turn then closes normally.
    session.simulateClose(1000, "normal");

    const finals = events.filter((e) => e.type === "final");
    expect(finals).toEqual([{ type: "final", text: "goodbye" }]);

    const closedEvents = events.filter((e) => e.type === "closed");
    expect(closedEvents).toHaveLength(1);
  });

  test("stop() emits final from accumulated turn text even if provider closes without turnComplete", async () => {
    const { transcriber: t, session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "partial only" } },
    });
    t.stop();
    session.simulateClose(1000, "normal");

    const finals = events.filter((e) => e.type === "final");
    expect(finals).toEqual([{ type: "final", text: "partial only" }]);
  });

  test("stop() falls back to emitting empty final and closed if no audio was ever transcribed", async () => {
    const { transcriber: t, session, events } = await startSession();

    t.stop();
    session.simulateClose(1000, "normal");

    expect(events).toEqual([
      { type: "final", text: "" },
      { type: "closed" },
    ]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Close-code categorization
  // ─────────────────────────────────────────────────────────────────

  test("unexpected close with 1008 maps to auth error category", async () => {
    const { session, events } = await startSession();

    session.simulateClose(1008, "auth failed");

    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect((errs[0] as { category: string }).category).toBe("auth");
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
  });

  test("unexpected close with 4001 maps to auth error category", async () => {
    const { session, events } = await startSession();

    session.simulateClose(4001, "invalid api key");

    const errs = events.filter((e) => e.type === "error");
    expect((errs[0] as { category: string }).category).toBe("auth");
  });

  test("unexpected close with 1013 maps to rate-limit error category", async () => {
    const { session, events } = await startSession();

    session.simulateClose(1013, "try again later");

    const errs = events.filter((e) => e.type === "error");
    expect((errs[0] as { category: string }).category).toBe("rate-limit");
  });

  test("unexpected close with arbitrary code maps to provider-error", async () => {
    const { session, events } = await startSession();

    session.simulateClose(1006, "abnormal closure");

    const errs = events.filter((e) => e.type === "error");
    expect((errs[0] as { category: string }).category).toBe("provider-error");
    expect((errs[0] as { message: string }).message).toContain("1006");
  });

  test("session-level error event emits provider-error + closed", async () => {
    const { session, events } = await startSession();

    session.simulateError({ message: "boom" });

    const errs = events.filter((e) => e.type === "error");
    const closedEvents = events.filter((e) => e.type === "closed");
    expect(errs).toHaveLength(1);
    expect((errs[0] as { category: string }).category).toBe("provider-error");
    expect((errs[0] as { message: string }).message).toContain("boom");
    expect(closedEvents).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Inactivity timeout
  // ─────────────────────────────────────────────────────────────────

  test("inactivity timeout emits timeout error and closed", async () => {
    const { events } = await startSession({
      transcriberOptions: { inactivityTimeoutMs: 50 },
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const errs = events.filter((e) => e.type === "error");
    const closedEvents = events.filter((e) => e.type === "closed");
    expect(errs).toHaveLength(1);
    expect((errs[0] as { category: string }).category).toBe("timeout");
    expect((errs[0] as { message: string }).message).toContain("inactivity");
    expect(closedEvents).toHaveLength(1);
  });

  test("inactivity timer resets on incoming server messages", async () => {
    const { session, events } = await startSession({
      transcriberOptions: { inactivityTimeoutMs: 100 },
    });

    // Send a message before the timer fires.
    await new Promise((resolve) => setTimeout(resolve, 60));
    session.simulateMessage({
      serverContent: { inputTranscription: { text: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should not have timed out because the timer reset on the message.
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // No events after closed
  // ─────────────────────────────────────────────────────────────────

  test("no events are emitted between final and closed on stop()", async () => {
    const { transcriber: t, session, events } = await startSession();

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "abc" } },
    });
    t.stop();

    // Partial-style messages after stop() should not produce additional
    // partial events (they are dropped because `stopping` is true) and
    // never interleave between final and closed.
    session.simulateMessage({
      serverContent: { inputTranscription: { text: " late" } },
    });

    session.simulateClose(1000, "");

    const types = events.map((e) => e.type);
    const lastTwo = types.slice(-2);
    expect(lastTwo).toEqual(["final", "closed"]);

    // No partials after the final.
    const finalIdx = types.indexOf("final");
    const afterFinal = types.slice(finalIdx + 1);
    expect(afterFinal).toEqual(["closed"]);
  });

  test("no events emitted after closed on unexpected close", async () => {
    const { session, events } = await startSession();

    session.simulateError(new Error("boom"));

    const count = events.length;

    session.simulateMessage({
      serverContent: { inputTranscription: { text: "late" } },
    });
    session.simulateClose(1000, "");

    expect(events.length).toBe(count);
  });

  // ─────────────────────────────────────────────────────────────────
  // Provider identity
  // ─────────────────────────────────────────────────────────────────

  test("reports correct providerId and boundaryId", () => {
    const t = new GoogleGeminiLiveStreamingTranscriber(TEST_API_KEY);
    expect(t.providerId).toBe("google-gemini");
    expect(t.boundaryId).toBe("daemon-streaming");
  });
});
