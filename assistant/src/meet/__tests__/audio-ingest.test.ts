/**
 * Unit tests for {@link MeetAudioIngest}.
 *
 * These tests exercise the ingest in isolation by injecting fake factories
 * for both the streaming transcriber and the Unix-socket server. No real
 * network or filesystem socket is opened.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test
// ---------------------------------------------------------------------------

// Intercept `resolveStreamingTranscriber` so we can assert the default
// `createTranscriber` path passes the expected diarize preference through.
// Tests that inject their own `createTranscriber` never hit this mock.
let mockResolveCalls: Array<Record<string, unknown> | undefined> = [];
let mockResolveResult: StreamingTranscriber | null = null;

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: async (options?: Record<string, unknown>) => {
    mockResolveCalls.push(options);
    return mockResolveResult;
  },
}));

// ---------------------------------------------------------------------------
// Imports under test — after mocks
// ---------------------------------------------------------------------------

import {
  BOT_CONNECT_TIMEOUT_MS,
  MeetAudioIngest,
  MeetAudioIngestError,
  type UnixSocketConnection,
  type UnixSocketServer,
} from "../audio-ingest.js";
import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
} from "../session-event-router.js";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

/**
 * Fake streaming transcriber. Records every audio chunk it receives and
 * exposes an `emit` helper so tests can inject synthetic transcript events.
 */
class FakeStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  readonly audioChunks: Buffer[] = [];
  startCalls = 0;
  stopCalls = 0;
  started = false;

  private listener: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.startCalls++;
    this.listener = onEvent;
    this.started = true;
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    this.audioChunks.push(audio);
  }

  stop(): void {
    this.stopCalls++;
    this.listener = null;
    this.started = false;
  }

  /** Test helper: inject a transcript event. */
  emit(event: SttStreamServerEvent): void {
    this.listener?.(event);
  }
}

/**
 * Fake socket connection. Tests drive it by calling `emitData`, `emitClose`
 * and `emitError` to exercise the ingest's inbound handlers.
 */
class FakeSocketConnection implements UnixSocketConnection {
  readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  readonly closeListeners: Array<() => void> = [];
  readonly errorListeners: Array<(err: Error) => void> = [];
  destroyed = false;

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.errorListeners.push(listener);
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Test helper: feed inbound data. */
  emitData(chunk: Buffer): void {
    for (const l of this.dataListeners) l(chunk);
  }

  /** Test helper: simulate the bot disconnecting. */
  emitClose(): void {
    for (const l of this.closeListeners) l();
  }

  /** Test helper: simulate a socket-level error. */
  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

/**
 * Fake unix-socket server. `listen()` returns one of these; tests trigger
 * a bot connection by calling `connectBot()`.
 */
class FakeUnixSocketServer implements UnixSocketServer {
  private connectionListeners: Array<(conn: UnixSocketConnection) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  closed = false;
  closedPromiseResolved = false;

  onConnection(listener: (conn: UnixSocketConnection) => void): void {
    this.connectionListeners.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.errorListeners.push(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closedPromiseResolved = true;
  }

  /** Test helper: deliver a new connection to all registered listeners. */
  connectBot(): FakeSocketConnection {
    const conn = new FakeSocketConnection();
    for (const l of this.connectionListeners) l(conn);
    return conn;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Flush multiple microtask ticks so callers can let the ingest's internal
 * await chain settle before asserting that its connection listener is
 * registered. Keep this larger than the ingest's actual chain depth so
 * changes to the number of internal awaits don't make the tests flake.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function newIngestSetup(): {
  server: FakeUnixSocketServer;
  session: FakeStreamingTranscriber;
  ingest: MeetAudioIngest;
  listenCalls: string[];
  createTranscriberCalls: number;
} {
  const server = new FakeUnixSocketServer();
  let session: FakeStreamingTranscriber | null = null;
  const listenCalls: string[] = [];
  let createTranscriberCalls = 0;
  const ingest = new MeetAudioIngest({
    createTranscriber: async () => {
      createTranscriberCalls++;
      session = new FakeStreamingTranscriber();
      return session;
    },
    listen: async (path) => {
      listenCalls.push(path);
      return server;
    },
  });
  return {
    server,
    get session() {
      if (!session) throw new Error("Streaming transcriber not created yet");
      return session;
    },
    ingest,
    listenCalls,
    get createTranscriberCalls() {
      return createTranscriberCalls;
    },
  } as unknown as {
    server: FakeUnixSocketServer;
    session: FakeStreamingTranscriber;
    ingest: MeetAudioIngest;
    listenCalls: string[];
    createTranscriberCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetMeetSessionEventRouterForTests();
  mockResolveCalls = [];
  mockResolveResult = null;
});

afterEach(() => {
  __resetMeetSessionEventRouterForTests();
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe("MeetAudioIngest.start", () => {
  test("opens streaming transcriber, opens socket server, resolves on bot connect", async () => {
    const setup = newIngestSetup();

    const startPromise = setup.ingest.start("m1", "/tmp/fake-audio.sock");

    // The listen factory was called with the provided path.
    // The ingest awaits `listen()` before registering its connection
    // listener, so we need to let microtasks run before connecting.
    await flushMicrotasks();

    expect(setup.listenCalls).toEqual(["/tmp/fake-audio.sock"]);
    expect(setup.createTranscriberCalls).toBe(1);

    // Simulate the bot dialing in.
    setup.server.connectBot();
    await startPromise;

    expect(setup.session.started).toBe(true);
  });

  test("rejects when the transcriber fails to connect (and does not open the socket)", async () => {
    const listen = mock(async () => new FakeUnixSocketServer());
    const createTranscriber = mock(async () => ({
      providerId: "deepgram" as const,
      boundaryId: "daemon-streaming" as const,
      start: async () => {
        throw new Error("stt auth failed");
      },
      sendAudio: () => {},
      stop: () => {},
    }));

    const ingest = new MeetAudioIngest({
      createTranscriber,
      listen,
    });

    await expect(ingest.start("m1", "/tmp/x.sock")).rejects.toThrow(
      /stt auth failed/,
    );
    expect(listen).toHaveBeenCalledTimes(0);
  });

  test("rejects and tears the transcriber down when the socket server fails to open", async () => {
    const sessionsStopped: number[] = [];
    let session: FakeStreamingTranscriber | null = null;
    const ingest = new MeetAudioIngest({
      createTranscriber: async () => {
        session = new FakeStreamingTranscriber();
        const origStop = session.stop.bind(session);
        session.stop = () => {
          sessionsStopped.push(Date.now());
          origStop();
        };
        return session;
      },
      listen: async () => {
        throw new Error("EADDRINUSE");
      },
    });

    await expect(ingest.start("m1", "/tmp/x.sock")).rejects.toThrow(
      /EADDRINUSE/,
    );
    expect(session).not.toBeNull();
    expect(sessionsStopped).toHaveLength(1);
  });

  test("rejects with MeetAudioIngestError when no streaming provider is configured, cleaning up the socket path", async () => {
    const unlinkCalls: string[] = [];
    const closedServers: FakeUnixSocketServer[] = [];
    const server = new FakeUnixSocketServer();
    // Wrap close so we can verify the server is not opened (close is never called)
    // on the missing-provider path.
    const origClose = server.close.bind(server);
    server.close = async () => {
      closedServers.push(server);
      await origClose();
    };

    const ingest = new MeetAudioIngest({
      createTranscriber: async () => {
        throw new MeetAudioIngestError(
          "No streaming-capable STT provider is configured. " +
            "Set services.stt.provider to deepgram, google-gemini, or openai-whisper " +
            "and ensure credentials are present.",
        );
      },
      listen: async (path) => {
        unlinkCalls.push(path);
        return server;
      },
    });

    const rejection = ingest.start("m-missing", "/tmp/missing.sock");
    await expect(rejection).rejects.toThrow(
      /No streaming-capable STT provider is configured/,
    );
    await expect(rejection).rejects.toBeInstanceOf(MeetAudioIngestError);
    try {
      await rejection;
    } catch (err) {
      expect(err).toBeInstanceOf(MeetAudioIngestError);
    }

    // listen() was never called — socket path is uncreated and does not leak.
    expect(unlinkCalls).toHaveLength(0);
    expect(closedServers).toHaveLength(0);

    // stop() is idempotent and safe to call on a failed-to-start ingest.
    await ingest.stop();
  });

  test("rejects start() when the bot does not connect within the timeout", async () => {
    // Monkey-patch setTimeout so we can fire the watchdog without waiting.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers: Array<{
      handle: symbol;
      cb: () => void;
      ms: number;
      fired: boolean;
    }> = [];
    let nextId = 0;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      cb: () => void,
      ms: number,
    ) => {
      const handle = Symbol(`timer-${nextId++}`);
      timers.push({ handle, cb, ms, fired: false });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    (
      globalThis as unknown as { clearTimeout: typeof clearTimeout }
    ).clearTimeout = ((handle: unknown) => {
      const t = timers.find((t) => t.handle === handle);
      if (t) t.fired = true; // "cleared" is effectively never-fire
    }) as typeof clearTimeout;

    try {
      const setup = newIngestSetup();
      const startPromise = setup.ingest.start("m1", "/tmp/timeout.sock");

      // Let microtasks settle so the ingest has called `listen()` and
      // registered its watchdog.
      await flushMicrotasks();

      // The watchdog is the only pending timer — locate it and fire it.
      const pending = timers.filter((t) => !t.fired);
      expect(pending).toHaveLength(1);
      expect(pending[0].ms).toBe(BOT_CONNECT_TIMEOUT_MS);
      pending[0].cb();
      pending[0].fired = true;

      await expect(startPromise).rejects.toThrow(
        /bot did not connect to .*timeout\.sock within/,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// Audio forwarding + transcript dispatch
// ---------------------------------------------------------------------------

describe("MeetAudioIngest — audio forwarding + transcript dispatch", () => {
  test("forwards PCM bytes from the bot to the transcriber", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start("m-forward", "/tmp/audio.sock");
    await flushMicrotasks();

    const conn = setup.server.connectBot();
    await startPromise;

    const pcm1 = Buffer.from([0x01, 0x02, 0x03]);
    const pcm2 = Buffer.from([0x04, 0x05]);
    conn.emitData(pcm1);
    conn.emitData(pcm2);

    expect(setup.session.audioChunks).toHaveLength(2);
    expect(setup.session.audioChunks[0]).toEqual(pcm1);
    expect(setup.session.audioChunks[1]).toEqual(pcm2);

    await setup.ingest.stop();
  });

  test("dispatches partial transcriber events as non-final transcript chunks", async () => {
    const setup = newIngestSetup();
    const captured: Array<Parameters<typeof dispatchMock>[1]> = [];
    const dispatchMock = mock((_meetingId: string, event: unknown) => {
      captured.push(event as (typeof captured)[number]);
    });
    // Register a handler so dispatch actually fires.
    getMeetSessionEventRouter().register("m-partial", (e) =>
      dispatchMock("m-partial", e),
    );

    const startPromise = setup.ingest.start("m-partial", "/tmp/partial.sock");
    await flushMicrotasks();
    setup.server.connectBot();
    await startPromise;

    setup.session.emit({ type: "partial", text: "hello " });

    expect(captured).toHaveLength(1);
    const event = captured[0] as unknown as {
      type: string;
      meetingId: string;
      isFinal: boolean;
      text: string;
      timestamp: string;
    };
    expect(event.type).toBe("transcript.chunk");
    expect(event.meetingId).toBe("m-partial");
    expect(event.isFinal).toBe(false);
    expect(event.text).toBe("hello ");
    // timestamp is an ISO-8601 string per the contract.
    expect(typeof event.timestamp).toBe("string");
    expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);

    await setup.ingest.stop();
  });

  test("dispatches final transcriber events as final transcript chunks", async () => {
    const setup = newIngestSetup();
    const captured: Array<unknown> = [];
    getMeetSessionEventRouter().register("m-final", (e) => captured.push(e));

    const startPromise = setup.ingest.start("m-final", "/tmp/final.sock");
    await flushMicrotasks();
    setup.server.connectBot();
    await startPromise;

    setup.session.emit({ type: "final", text: "hello world." });

    expect(captured).toHaveLength(1);
    const event = captured[0] as {
      type: string;
      isFinal: boolean;
      text: string;
    };
    expect(event.type).toBe("transcript.chunk");
    expect(event.isFinal).toBe(true);
    expect(event.text).toBe("hello world.");

    await setup.ingest.stop();
  });

  test("propagates speakerLabel and confidence from partial and final events into TranscriptChunkEvent", async () => {
    const setup = newIngestSetup();
    const captured: Array<unknown> = [];
    getMeetSessionEventRouter().register("m-speaker", (e) => captured.push(e));

    const startPromise = setup.ingest.start("m-speaker", "/tmp/speaker.sock");
    await flushMicrotasks();
    setup.server.connectBot();
    await startPromise;

    // Partial event with a speaker label + confidence.
    setup.session.emit({
      type: "partial",
      text: "hi ",
      speakerLabel: "1",
      confidence: 0.5,
    });
    // Final event with a different speaker label + confidence.
    setup.session.emit({
      type: "final",
      text: "hi there.",
      speakerLabel: "2",
      confidence: 0.92,
    });
    // Event without a speaker label or confidence — fields stay undefined.
    setup.session.emit({ type: "partial", text: "..." });

    expect(captured).toHaveLength(3);

    const partial = captured[0] as {
      type: string;
      isFinal: boolean;
      text: string;
      speakerLabel?: string;
      confidence?: number;
    };
    expect(partial.type).toBe("transcript.chunk");
    expect(partial.isFinal).toBe(false);
    expect(partial.text).toBe("hi ");
    expect(partial.speakerLabel).toBe("1");
    expect(partial.confidence).toBe(0.5);

    const final = captured[1] as {
      type: string;
      isFinal: boolean;
      text: string;
      speakerLabel?: string;
      confidence?: number;
    };
    expect(final.type).toBe("transcript.chunk");
    expect(final.isFinal).toBe(true);
    expect(final.text).toBe("hi there.");
    expect(final.speakerLabel).toBe("2");
    expect(final.confidence).toBe(0.92);

    const unlabeled = captured[2] as {
      type: string;
      speakerLabel?: string;
      confidence?: number;
    };
    expect(unlabeled.type).toBe("transcript.chunk");
    expect(unlabeled.speakerLabel).toBeUndefined();
    expect(unlabeled.confidence).toBeUndefined();

    await setup.ingest.stop();
  });

  test("does not dispatch non-transcript events (error / closed)", async () => {
    const setup = newIngestSetup();
    const captured: Array<unknown> = [];
    getMeetSessionEventRouter().register("m-ignore", (e) => captured.push(e));

    const startPromise = setup.ingest.start("m-ignore", "/tmp/ignore.sock");
    await flushMicrotasks();
    setup.server.connectBot();
    await startPromise;

    setup.session.emit({
      type: "error",
      category: "provider-error",
      message: "boom",
    });
    setup.session.emit({ type: "closed" });

    expect(captured).toHaveLength(0);

    await setup.ingest.stop();
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe("MeetAudioIngest.stop", () => {
  test("destroys connection, stops transcriber, closes server", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start("m-stop", "/tmp/stop.sock");
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await startPromise;

    await setup.ingest.stop();

    expect(conn.destroyed).toBe(true);
    expect(setup.session.stopCalls).toBe(1);
    expect(setup.server.closed).toBe(true);
  });

  test("is idempotent", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start("m-idem", "/tmp/idem.sock");
    await flushMicrotasks();
    setup.server.connectBot();
    await startPromise;

    await setup.ingest.stop();
    await setup.ingest.stop();
    await setup.ingest.stop();

    expect(setup.session.stopCalls).toBe(1);
  });

  test("drops audio sent after stop", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start(
      "m-afterstop",
      "/tmp/afterstop.sock",
    );
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await startPromise;

    await setup.ingest.stop();
    conn.emitData(Buffer.from([0x0a, 0x0b]));

    // Stop was synchronous wrt. the connection — any late data is dropped.
    expect(setup.session.audioChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Default transcriber factory — diarization wiring
// ---------------------------------------------------------------------------

describe("MeetAudioIngest — default transcriber factory", () => {
  test("requests diarize: preferred from the resolver", async () => {
    // The fake resolver returns a minimal StreamingTranscriber so the
    // ingest has something to drive. We don't exercise the streaming path
    // here — we just need start() to reach the resolver call.
    const fakeSession = new FakeStreamingTranscriber();
    mockResolveResult = fakeSession;

    // No createTranscriber override — exercises the default factory path.
    const ingest = new MeetAudioIngest({
      listen: async () => new FakeUnixSocketServer(),
      botConnectTimeoutMs: 1_000,
    });

    // Kick off start(); we don't need it to resolve, just to call the
    // resolver. Attach a noop rejection handler so the bot-connect timeout
    // doesn't surface as an unhandled rejection when the test finishes.
    const startPromise = ingest.start("m-diarize", "/tmp/diarize.sock");
    startPromise.catch(() => {});
    await flushMicrotasks();

    expect(mockResolveCalls).toHaveLength(1);
    const opts = mockResolveCalls[0];
    expect(opts).toBeDefined();
    expect((opts as { diarize?: string }).diarize).toBe("preferred");
    // Sanity check that the sample rate is still forwarded.
    expect((opts as { sampleRate?: number }).sampleRate).toBeGreaterThan(0);

    await ingest.stop();
  });

  test("throws MeetAudioIngestError when the resolver returns null", async () => {
    // Unusable provider configuration — resolver returns null.
    mockResolveResult = null;

    const ingest = new MeetAudioIngest({
      listen: async () => new FakeUnixSocketServer(),
    });

    await expect(ingest.start("m-null", "/tmp/null.sock")).rejects.toThrow(
      MeetAudioIngestError,
    );
    await expect(ingest.start("m-null2", "/tmp/null2.sock")).rejects.toThrow(
      /configured STT provider is unusable/i,
    );
  });
});
