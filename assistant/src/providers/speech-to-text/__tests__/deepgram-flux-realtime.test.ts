import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../../stt/types.js";
import { SttError } from "../../../stt/types.js";

// ---------------------------------------------------------------------------
// Logger mock — must be declared before the subject import
//
// The adapter's only observable output for the chunk-cadence measurement is a
// debug log line, and the Configure-failure contract is "warn, never a stream
// error", so both are asserted through captured logs.
// ---------------------------------------------------------------------------

interface CapturedLog {
  data: unknown;
  message: string;
}

const debugLogs: CapturedLog[] = [];
const warnLogs: CapturedLog[] = [];

function capture(sink: CapturedLog[]) {
  return (data: unknown, message?: string) => {
    sink.push(
      typeof data === "string"
        ? { data: undefined, message: data }
        : { data, message: message ?? "" },
    );
  };
}

mock.module("../../../util/logger.js", () => {
  const logger = {
    debug: capture(debugLogs),
    warn: capture(warnLogs),
    info: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return { getLogger: () => logger };
});

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventType = "open" | "close" | "error" | "message";
type WsListener = (...args: unknown[]) => void;

/** Minimal mock WebSocket standing in for Deepgram's `/v2/listen` endpoint. */
class MockWebSocket {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;

  /** Everything passed to `.send()`, in order. */
  sentData: (string | Uint8Array)[] = [];

  private listeners = new Map<WsEventType, WsListener[]>();

  addEventListener(type: WsEventType, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: unknown): void {
    const list = this.listeners.get(type as WsEventType);
    const idx = list?.indexOf(listener as WsListener) ?? -1;
    if (list && idx !== -1) {
      list.splice(idx, 1);
    }
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.sentData.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  // ── Test helpers ──────────────────────────────────────────────────

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    for (const l of this.listeners.get("open") ?? []) {
      l();
    }
  }

  simulateMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) {
      l({ data });
    }
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) {
      l({ code, reason });
    }
  }

  simulateError(err: unknown): void {
    for (const l of this.listeners.get("error") ?? []) {
      l(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

const { DeepgramFluxRealtimeTranscriber } =
  await import("../deepgram-flux-realtime.js");

const TEST_API_KEY = "dg-flux-test-key";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Flux `TurnInfo` frame carrying the given turn state. */
function turnInfoFrame(
  event: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "TurnInfo",
    event,
    request_id: "flux-request-id",
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 1.5,
    ...extra,
  });
}

describe("DeepgramFluxRealtimeTranscriber", () => {
  let mockWs: MockWebSocket;
  let dialedUrls: string[];
  let dialedOptions: ({ headers?: Record<string, string> } | undefined)[];
  let originalWebSocket: unknown;

  beforeEach(() => {
    // A fully default config: the acceptance criteria are about what the
    // shipped defaults dial.
    setConfig("liveVoice", {});

    mockWs = new MockWebSocket();
    dialedUrls = [];
    dialedOptions = [];
    debugLogs.length = 0;
    warnLogs.length = 0;

    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        dialedUrls.push(url);
        dialedOptions.push(options);
        return mockWs;
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  async function startSession(
    options: ConstructorParameters<
      typeof DeepgramFluxRealtimeTranscriber
    >[1] = {},
  ): Promise<{
    transcriber: InstanceType<typeof DeepgramFluxRealtimeTranscriber>;
    events: SttStreamServerEvent[];
  }> {
    const transcriber = new DeepgramFluxRealtimeTranscriber(TEST_API_KEY, {
      // Long enough that no watchdog fires mid-test.
      inactivityTimeoutMs: 60_000,
      keepaliveIntervalMs: 0,
      ...options,
    });
    const events: SttStreamServerEvent[] = [];

    const startPromise = transcriber.start((event) => events.push(event));
    mockWs.simulateOpen();
    await startPromise;

    return { transcriber, events };
  }

  // ─────────────────────────────────────────────────────────────────
  // Dialed URL
  // ─────────────────────────────────────────────────────────────────

  describe("session URL", () => {
    test("dials /v2/listen with the default Flux tuning and no eager threshold", async () => {
      await startSession();

      expect(dialedUrls).toHaveLength(1);
      const url = new URL(dialedUrls[0]!);

      expect(url.protocol).toBe("wss:");
      expect(url.host).toBe("api.deepgram.com");
      expect(url.pathname).toBe("/v2/listen");
      expect(url.searchParams.get("model")).toBe("flux-general-en");
      expect(url.searchParams.get("eot_threshold")).toBe("0.7");
      expect(url.searchParams.get("eot_timeout_ms")).toBe("5000");
      // Unset eager threshold is what keeps Deepgram from speculating turns.
      expect(url.searchParams.has("eager_eot_threshold")).toBe(false);
    });

    test("sends the negotiated raw-audio format", async () => {
      await startSession({ sampleRate: 24_000 });

      const url = new URL(dialedUrls[0]!);
      expect(url.searchParams.get("encoding")).toBe("linear16");
      expect(url.searchParams.get("sample_rate")).toBe("24000");
    });

    test("authenticates with the Token header, never the query string", async () => {
      await startSession();

      expect(dialedOptions[0]?.headers?.Authorization).toBe(
        `Token ${TEST_API_KEY}`,
      );
      expect(dialedUrls[0]).not.toContain(TEST_API_KEY);
    });

    test("takes its tuning from liveVoice.flux", async () => {
      setConfig("liveVoice", {
        flux: {
          model: "flux-general-multi",
          eotThreshold: 0.9,
          eagerEotThreshold: 0.4,
          eotTimeoutMs: 1_500,
        },
      });

      await startSession();

      const url = new URL(dialedUrls[0]!);
      expect(url.searchParams.get("model")).toBe("flux-general-multi");
      expect(url.searchParams.get("eot_threshold")).toBe("0.9");
      expect(url.searchParams.get("eager_eot_threshold")).toBe("0.4");
      expect(url.searchParams.get("eot_timeout_ms")).toBe("1500");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Audio forwarding
  // ─────────────────────────────────────────────────────────────────

  describe("audio forwarding", () => {
    test("forwards audio chunks to the socket as raw bytes", async () => {
      const { transcriber } = await startSession();

      transcriber.sendAudio(Buffer.from([1, 2, 3, 4]), "audio/pcm");
      transcriber.sendAudio(Buffer.from([5, 6]), "audio/pcm");

      expect(mockWs.sentData).toHaveLength(2);
      expect(Array.from(mockWs.sentData[0] as Uint8Array)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(Array.from(mockWs.sentData[1] as Uint8Array)).toEqual([5, 6]);
    });

    test("drops audio once the outbound buffer is saturated", async () => {
      const { transcriber } = await startSession();
      mockWs.bufferedAmount = 8 * 1024 * 1024;

      transcriber.sendAudio(Buffer.from([1, 2]), "audio/pcm");

      expect(mockWs.sentData).toHaveLength(0);
    });

    test("logs the observed chunk duration once per session", async () => {
      const { transcriber } = await startSession({ sampleRate: 16_000 });

      // 2560 bytes of mono linear16 at 16kHz is exactly 80ms.
      transcriber.sendAudio(Buffer.alloc(2560), "audio/pcm");
      transcriber.sendAudio(Buffer.alloc(2560), "audio/pcm");

      const cadenceLogs = debugLogs.filter((entry) =>
        entry.message.includes("chunk cadence"),
      );
      expect(cadenceLogs).toHaveLength(1);
      expect(cadenceLogs[0]!.data).toMatchObject({
        observedChunkMs: 80,
        recommendedChunkMs: 80,
        sampleRate: 16_000,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Frame handling
  // ─────────────────────────────────────────────────────────────────

  describe("frame handling", () => {
    test("a scripted turn produces the expected event stream", async () => {
      const { events } = await startSession();

      mockWs.simulateMessage(
        JSON.stringify({ type: "Connected", request_id: "flux-request-id" }),
      );
      mockWs.simulateMessage(turnInfoFrame("StartOfTurn"));
      mockWs.simulateMessage(
        turnInfoFrame("Update", { transcript: "what is the" }),
      );
      mockWs.simulateMessage(
        turnInfoFrame("EndOfTurn", {
          transcript: "what is the weather",
          end_of_turn_confidence: 0.91,
        }),
      );

      expect(events).toEqual([
        { type: "turn-start" },
        { type: "partial", text: "what is the" },
        // The final comes first so a consumer that ignores turn events still
        // commits the transcript exactly as it does for any other provider.
        { type: "final", text: "what is the weather" },
        { type: "turn-end", text: "what is the weather", confidence: 0.91 },
      ]);
    });

    test("an EndOfTurn frame emits final before turn-end", async () => {
      const { events } = await startSession();

      mockWs.simulateMessage(
        turnInfoFrame("EndOfTurn", { transcript: "done" }),
      );

      expect(events.map((event) => event.type)).toEqual(["final", "turn-end"]);
    });

    test("a fatal Error frame surfaces its category", async () => {
      const { events } = await startSession();

      mockWs.simulateMessage(
        JSON.stringify({
          type: "Error",
          code: "INVALID_AUTH",
          description: "Invalid credentials",
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", category: "auth" });
    });

    test("malformed frames are dropped rather than surfaced", async () => {
      const { events } = await startSession();

      mockWs.simulateMessage("not json at all");
      mockWs.simulateMessage(JSON.stringify([1, 2, 3]));
      mockWs.simulateMessage(
        JSON.stringify({ type: "SomethingNewFromDeepgram" }),
      );

      expect(events).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Configure acknowledgements
  // ─────────────────────────────────────────────────────────────────

  describe("Configure acknowledgements", () => {
    test("ConfigureSuccess logs the authoritative thresholds and emits nothing", async () => {
      const { events } = await startSession();

      mockWs.simulateMessage(
        JSON.stringify({
          type: "ConfigureSuccess",
          thresholds: {
            eot_threshold: 0.8,
            eager_eot_threshold: 0.4,
            eot_timeout_ms: 6_000,
          },
        }),
      );

      expect(events).toEqual([]);
      const ack = debugLogs.find((entry) =>
        entry.message.includes("accepted a Configure"),
      );
      expect(ack).toBeDefined();
      expect(ack!.data).toMatchObject({
        thresholds: { eot_threshold: 0.8, eot_timeout_ms: 6_000 },
      });
    });

    test("ConfigureFailure warns and leaves the session usable", async () => {
      const { transcriber, events } = await startSession();

      mockWs.simulateMessage(
        JSON.stringify({
          type: "ConfigureFailure",
          sequence_id: 42,
          code: "INVALID_THRESHOLD",
          description:
            "eager_eot_threshold must be less than or equal to eot_threshold",
        }),
      );

      // A rejected Configure leaves the stream on its previous settings, so
      // it must not become a stream error that tears the session down.
      expect(events).toEqual([]);
      const rejection = warnLogs.find((entry) =>
        entry.message.includes("rejected a Configure"),
      );
      expect(rejection).toBeDefined();
      expect(rejection!.data).toMatchObject({ code: "INVALID_THRESHOLD" });

      // The session still transcribes.
      mockWs.simulateMessage(
        turnInfoFrame("EndOfTurn", { transcript: "still here" }),
      );
      expect(events.map((event) => event.type)).toEqual(["final", "turn-end"]);

      transcriber.stop();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error mapping
  // ─────────────────────────────────────────────────────────────────

  describe("error mapping", () => {
    test("an auth rejection during connect rejects with an auth SttError", async () => {
      const transcriber = new DeepgramFluxRealtimeTranscriber(TEST_API_KEY);
      const startPromise = transcriber.start(() => {});
      mockWs.simulateClose(1008, "invalid credentials");

      const err = await startPromise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("auth");
    });

    test("a connect timeout rejects with a timeout SttError", async () => {
      const transcriber = new DeepgramFluxRealtimeTranscriber(TEST_API_KEY, {
        connectTimeoutMs: 20,
      });

      const err = await transcriber.start(() => {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("timeout");
    });

    test("an in-session auth close emits an auth error then closed", async () => {
      const { events } = await startSession();

      mockWs.simulateClose(1008, "invalid credentials");

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "error", category: "auth" });
      expect(events[1]).toEqual({ type: "closed" });
    });

    test("a load-shedding close maps to rate-limit", async () => {
      const { events } = await startSession();

      mockWs.simulateClose(1013, "try again later");

      expect(events[0]).toMatchObject({
        type: "error",
        category: "rate-limit",
      });
    });

    test("any other unexpected close maps to provider-error", async () => {
      const { events } = await startSession();

      mockWs.simulateClose(1006, "abnormal");

      expect(events[0]).toMatchObject({
        type: "error",
        category: "provider-error",
      });
    });

    test("a socket error emits provider-error then closed", async () => {
      const { events } = await startSession();

      mockWs.simulateError(new Error("connection reset"));

      expect(events[0]).toMatchObject({
        type: "error",
        category: "provider-error",
      });
      expect(events[1]).toEqual({ type: "closed" });
    });

    test("the inactivity watchdog only fires while audio awaits a response", async () => {
      const { transcriber, events } = await startSession({
        inactivityTimeoutMs: 20,
      });

      // Idle with nothing owed: the watchdog re-arms rather than firing.
      await Bun.sleep(60);
      expect(events).toEqual([]);

      transcriber.sendAudio(Buffer.from([1, 2]), "audio/pcm");
      await Bun.sleep(80);

      expect(events[0]).toMatchObject({ type: "error", category: "timeout" });
      expect(events.at(-1)).toEqual({ type: "closed" });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    test("start() throws when called twice", async () => {
      const { transcriber } = await startSession();

      await expect(transcriber.start(() => {})).rejects.toThrow(
        "start() called twice",
      );
    });

    test("stop() sends CloseStream and reports closed once the socket closes", async () => {
      const { transcriber, events } = await startSession();

      transcriber.stop();

      expect(mockWs.sentData).toEqual([
        JSON.stringify({ type: "CloseStream" }),
      ]);
      expect(events).toEqual([]);

      mockWs.simulateClose(1000, "");
      expect(events).toEqual([{ type: "closed" }]);
    });

    test("stop() is idempotent and closed is emitted exactly once", async () => {
      const { transcriber, events } = await startSession();

      transcriber.stop();
      mockWs.simulateClose(1000, "");
      transcriber.stop();
      mockWs.simulateClose(1000, "");

      expect(events).toEqual([{ type: "closed" }]);
    });

    test("keepalive frames go out on the configured interval", async () => {
      const { transcriber } = await startSession({ keepaliveIntervalMs: 10 });

      await Bun.sleep(35);
      transcriber.stop();

      const keepalives = mockWs.sentData.filter(
        (data) => data === JSON.stringify({ type: "KeepAlive" }),
      );
      expect(keepalives.length).toBeGreaterThanOrEqual(2);
    });

    test("finalizeUtterance is deliberately absent — Flux owns turn boundaries", async () => {
      const { transcriber } = await startSession();

      // Callers feature-detect this method and fall back to stop(), which is
      // the correct semantics for a provider whose model ends the turn. The
      // contract type is where the optional method lives, so the check goes
      // through it — the class not declaring it at all is the point.
      const asContract: StreamingTranscriber = transcriber;
      expect(asContract.finalizeUtterance).toBeUndefined();
    });

    test("audio sent after stop() never reaches the socket", async () => {
      const { transcriber } = await startSession();

      transcriber.stop();
      mockWs.sentData.length = 0;
      transcriber.sendAudio(Buffer.from([1, 2]), "audio/pcm");

      expect(mockWs.sentData).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────────────

  test("reports the deepgram-flux provider on the daemon-streaming boundary", () => {
    const transcriber = new DeepgramFluxRealtimeTranscriber(TEST_API_KEY);

    expect(transcriber.providerId).toBe("deepgram-flux");
    expect(transcriber.boundaryId).toBe("daemon-streaming");
  });
});
