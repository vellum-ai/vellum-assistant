/**
 * Unit tests for {@link MeetAudioIngest}.
 *
 * These tests exercise the ingest in isolation by injecting fake factories
 * for both the streaming transcriber and the Unix-socket server. No real
 * network or filesystem socket is opened.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillHost } from "@vellumai/skill-host-contracts";

import {
  AUDIO_INGEST_AUTH_PREFIX,
  BOT_CONNECT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_HANDSHAKE_BYTES,
  MeetAudioIngest,
  MeetAudioIngestError,
  createAudioIngest,
  type AudioIngestConnection,
  type AudioIngestServer,
  type StreamingTranscriber,
  type SttStreamServerEvent,
} from "../audio-ingest.js";

/**
 * Deterministic token used in every test that doesn't care about the token
 * value. Keep it out of the 64-char hex shape the real bot generates so it
 * is obvious at a glance that this is a test literal.
 */
const TEST_BOT_TOKEN = "test-bot-token-0123456789abcdef";
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
class FakeSocketConnection implements AudioIngestConnection {
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

  /**
   * Test helper: feed inbound data.
   *
   * Snapshots `dataListeners` before iteration to mirror how Node's
   * `EventEmitter.emit` freezes the listener array at emit time — a
   * listener that adds another listener mid-emit must not have the new
   * listener fire for the current chunk. The audio-ingest handshake
   * relies on this: on successful auth it registers the PCM forwarder
   * via `wireConnection(conn, meetingId)`, and without a snapshot the
   * freshly-registered forwarder would see the auth-line bytes as PCM.
   */
  emitData(chunk: Buffer): void {
    for (const l of [...this.dataListeners]) l(chunk);
  }

  /** Test helper: simulate the bot disconnecting. */
  emitClose(): void {
    for (const l of [...this.closeListeners]) l();
  }

  /** Test helper: simulate a socket-level error. */
  emitError(err: Error): void {
    for (const l of [...this.errorListeners]) l(err);
  }
}

/**
 * Fake unix-socket server. `listen()` returns one of these; tests trigger
 * a bot connection by calling `connectBot()`.
 */
class FakeAudioIngestServer implements AudioIngestServer {
  readonly port: number;
  private connectionListeners: Array<(conn: AudioIngestConnection) => void> =
    [];
  private errorListeners: Array<(err: Error) => void> = [];
  closed = false;
  closedPromiseResolved = false;

  constructor(port = 42000) {
    this.port = port;
  }

  onConnection(listener: (conn: AudioIngestConnection) => void): void {
    this.connectionListeners.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.errorListeners.push(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closedPromiseResolved = true;
  }

  /**
   * Test helper: deliver a new connection to all registered listeners and,
   * by default, emit the `AUTH <token>\n` handshake line so the ingest's
   * handshake guard accepts the connection. Tests that exercise the
   * handshake itself pass `authLine` to send a custom line (or `null` to
   * send nothing).
   */
  connectBot(
    options: { authLine?: string | null; authToken?: string } = {},
  ): FakeSocketConnection {
    const conn = new FakeSocketConnection();
    for (const l of this.connectionListeners) l(conn);
    if (options.authLine !== null) {
      const line =
        options.authLine ??
        `${AUDIO_INGEST_AUTH_PREFIX}${options.authToken ?? TEST_BOT_TOKEN}\n`;
      conn.emitData(Buffer.from(line, "utf8"));
    }
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
  server: FakeAudioIngestServer;
  session: FakeStreamingTranscriber;
  ingest: MeetAudioIngest;
  listenCalls: number;
  createTranscriberCalls: number;
} {
  const server = new FakeAudioIngestServer();
  let session: FakeStreamingTranscriber | null = null;
  let listenCalls = 0;
  let createTranscriberCalls = 0;
  const ingest = new MeetAudioIngest({
    createTranscriber: async () => {
      createTranscriberCalls++;
      session = new FakeStreamingTranscriber();
      return session;
    },
    listen: async () => {
      listenCalls++;
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
    get listenCalls() {
      return listenCalls;
    },
    get createTranscriberCalls() {
      return createTranscriberCalls;
    },
  } as unknown as {
    server: FakeAudioIngestServer;
    session: FakeStreamingTranscriber;
    ingest: MeetAudioIngest;
    listenCalls: number;
    createTranscriberCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetMeetSessionEventRouterForTests();
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

    // start() now resolves with { port, ready } as soon as the listener
    // is bound — `ready` is the promise that waits for the bot to dial in.
    const { port, ready } = await setup.ingest.start("m1", TEST_BOT_TOKEN);

    expect(port).toBe(42000);
    expect(setup.listenCalls).toBe(1);
    expect(setup.createTranscriberCalls).toBe(1);

    // Simulate the bot dialing in.
    setup.server.connectBot();
    await ready;

    expect(setup.session.started).toBe(true);
  });

  test("rejects when the transcriber fails to connect (and does not open the socket)", async () => {
    const listen = mock(async () => new FakeAudioIngestServer());
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

    await expect(ingest.start("m1", TEST_BOT_TOKEN)).rejects.toThrow(
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

    await expect(ingest.start("m1", TEST_BOT_TOKEN)).rejects.toThrow(
      /EADDRINUSE/,
    );
    expect(session).not.toBeNull();
    expect(sessionsStopped).toHaveLength(1);
  });

  test("rejects with MeetAudioIngestError when no streaming provider is configured, without opening the listen socket", async () => {
    let listenCalls = 0;
    const closedServers: FakeAudioIngestServer[] = [];
    const server = new FakeAudioIngestServer();
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
            "Set services.stt.provider to deepgram, google-gemini, openai-whisper, or xai " +
            "and ensure credentials are present.",
        );
      },
      listen: async () => {
        listenCalls++;
        return server;
      },
    });

    const rejection = ingest.start("m-missing", TEST_BOT_TOKEN);
    await expect(rejection).rejects.toThrow(
      /No streaming-capable STT provider is configured/,
    );
    await expect(rejection).rejects.toBeInstanceOf(MeetAudioIngestError);
    try {
      await rejection;
    } catch (err) {
      expect(err).toBeInstanceOf(MeetAudioIngestError);
    }

    // listen() was never called — no TCP port was bound.
    expect(listenCalls).toBe(0);
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
      const { ready } = await setup.ingest.start("m1", TEST_BOT_TOKEN);

      // Let microtasks settle so the ingest has called `listen()` and
      // registered its watchdog.
      await flushMicrotasks();

      // The watchdog is the only pending timer — locate it and fire it.
      const pending = timers.filter((t) => !t.fired);
      expect(pending).toHaveLength(1);
      expect(pending[0].ms).toBe(BOT_CONNECT_TIMEOUT_MS);
      pending[0].cb();
      pending[0].fired = true;

      await expect(ready).rejects.toThrow(
        /bot did not connect to \*:\d+ within/,
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
    const { ready } = await setup.ingest.start("m-forward", TEST_BOT_TOKEN);
    await flushMicrotasks();

    const conn = setup.server.connectBot();
    await ready;

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

    const { ready } = await setup.ingest.start("m-partial", TEST_BOT_TOKEN);
    await flushMicrotasks();
    setup.server.connectBot();
    await ready;

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

    const { ready } = await setup.ingest.start("m-final", TEST_BOT_TOKEN);
    await flushMicrotasks();
    setup.server.connectBot();
    await ready;

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

    const { ready } = await setup.ingest.start("m-speaker", TEST_BOT_TOKEN);
    await flushMicrotasks();
    setup.server.connectBot();
    await ready;

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

    const { ready } = await setup.ingest.start("m-ignore", TEST_BOT_TOKEN);
    await flushMicrotasks();
    setup.server.connectBot();
    await ready;

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

// ---------------------------------------------------------------------------
// PCM fan-out (subscribePcm)
// ---------------------------------------------------------------------------

describe("MeetAudioIngest PCM tee", () => {
  test("fans each PCM chunk to every subscriber in addition to the transcriber", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-tee", TEST_BOT_TOKEN);
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await ready;

    const a: Uint8Array[] = [];
    const b: Uint8Array[] = [];
    const unsubA = setup.ingest.subscribePcm((c) => a.push(c));
    const unsubB = setup.ingest.subscribePcm((c) => b.push(c));

    const pcm1 = Buffer.from([0x11, 0x22]);
    const pcm2 = Buffer.from([0x33]);
    conn.emitData(pcm1);
    conn.emitData(pcm2);

    // Transcriber still receives every chunk.
    expect(setup.session.audioChunks).toHaveLength(2);
    // Both subscribers see both chunks in order.
    expect(a.map((c) => Array.from(c))).toEqual([[0x11, 0x22], [0x33]]);
    expect(b.map((c) => Array.from(c))).toEqual([[0x11, 0x22], [0x33]]);

    unsubA();
    conn.emitData(Buffer.from([0x44]));
    expect(a).toHaveLength(2); // Did not receive the third chunk.
    expect(b).toHaveLength(3);

    unsubB();
    await setup.ingest.stop();
  });

  test("a throwing subscriber is logged + removed and does not break peers", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-throw", TEST_BOT_TOKEN);
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await ready;

    let thrown = 0;
    const throwing = () => {
      thrown += 1;
      throw new Error("subscriber boom");
    };
    const good: Uint8Array[] = [];
    setup.ingest.subscribePcm(throwing);
    setup.ingest.subscribePcm((c) => good.push(c));

    conn.emitData(Buffer.from([0x01]));
    conn.emitData(Buffer.from([0x02]));

    // Throwing subscriber fires once, then gets evicted — second chunk
    // still reaches the good subscriber.
    expect(thrown).toBe(1);
    expect(good).toHaveLength(2);

    await setup.ingest.stop();
  });

  test("subscribe before start still receives chunks after bot connects", async () => {
    const setup = newIngestSetup();
    const received: Uint8Array[] = [];
    const unsub = setup.ingest.subscribePcm((c) => received.push(c));

    const { ready } = await setup.ingest.start("m-early", TEST_BOT_TOKEN);
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await ready;

    conn.emitData(Buffer.from([0xab]));
    expect(received).toHaveLength(1);

    unsub();
    await setup.ingest.stop();
  });

  test("stop() drops all subscribers", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-stop-subs", TEST_BOT_TOKEN);
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await ready;

    const received: Uint8Array[] = [];
    setup.ingest.subscribePcm((c) => received.push(c));

    await setup.ingest.stop();
    // After stop the socket is destroyed; sending data would be a no-op
    // in production, but we can still verify that the ingest's subscriber
    // set was cleared.
    conn.emitData(Buffer.from([0xff]));
    expect(received).toHaveLength(0);
  });
});

describe("MeetAudioIngest.stop", () => {
  test("destroys connection, stops transcriber, closes server", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-stop", TEST_BOT_TOKEN);
    await flushMicrotasks();
    const conn = setup.server.connectBot();
    await ready;

    await setup.ingest.stop();

    expect(conn.destroyed).toBe(true);
    expect(setup.session.stopCalls).toBe(1);
    expect(setup.server.closed).toBe(true);
  });

  test("is idempotent", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-idem", TEST_BOT_TOKEN);
    await flushMicrotasks();
    setup.server.connectBot();
    await ready;

    await setup.ingest.stop();
    await setup.ingest.stop();
    await setup.ingest.stop();

    expect(setup.session.stopCalls).toBe(1);
  });

  test("drops audio sent after stop", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-afterstop", TEST_BOT_TOKEN);
    const conn = setup.server.connectBot();
    await ready;

    await setup.ingest.stop();
    conn.emitData(Buffer.from([0x0a, 0x0b]));

    // Stop was synchronous wrt. the connection — any late data is dropped.
    expect(setup.session.audioChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auth handshake
// ---------------------------------------------------------------------------

describe("MeetAudioIngest — auth handshake", () => {
  test("throws synchronously if start() is called without a token", async () => {
    const setup = newIngestSetup();
    await expect(setup.ingest.start("m-no-token", "")).rejects.toThrow(
      /botApiToken is required/,
    );
  });

  test("rejects a connection whose handshake prefix is malformed and keeps the listener open for a later good connection", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-bad-prefix", TEST_BOT_TOKEN);
    await flushMicrotasks();

    // Bogus prefix — no "AUTH " — must be rejected.
    const bad = setup.server.connectBot({ authLine: "HELLO world\n" });

    // Give the handshake logic a tick to run.
    await flushMicrotasks();
    expect(bad.destroyed).toBe(true);

    // A legitimate bot shows up afterwards — must still be accepted.
    const good = setup.server.connectBot();
    await ready;

    good.emitData(Buffer.from([0xaa, 0xbb]));
    expect(setup.session.audioChunks).toHaveLength(1);
    expect(setup.session.audioChunks[0]).toEqual(Buffer.from([0xaa, 0xbb]));

    await setup.ingest.stop();
  });

  test("rejects a connection that presents the wrong token", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-bad-token", TEST_BOT_TOKEN);
    await flushMicrotasks();

    const bad = setup.server.connectBot({
      authLine: `${AUDIO_INGEST_AUTH_PREFIX}not-the-token\n`,
    });
    await flushMicrotasks();
    expect(bad.destroyed).toBe(true);

    // Real bot follows — succeeds.
    setup.server.connectBot();
    await ready;

    await setup.ingest.stop();
  });

  test("rejects a connection that flood-writes without ever sending a newline", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-oversize", TEST_BOT_TOKEN);
    await flushMicrotasks();

    const bad = setup.server.connectBot({ authLine: null });
    // Send MAX_HANDSHAKE_BYTES + 1 bytes with no newline — handshake must
    // give up and destroy the socket without pinning arbitrary memory.
    bad.emitData(Buffer.alloc(MAX_HANDSHAKE_BYTES + 1, 0x41));
    await flushMicrotasks();
    expect(bad.destroyed).toBe(true);

    setup.server.connectBot();
    await ready;

    await setup.ingest.stop();
  });

  test("rejects a connection that opens but never sends any data (handshake timeout)", async () => {
    // Monkey-patch setTimeout so we can fire the handshake watchdog
    // without waiting HANDSHAKE_TIMEOUT_MS of wall-clock time.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    type Timer = {
      handle: symbol;
      cb: () => void;
      ms: number;
      fired: boolean;
    };
    const timers: Timer[] = [];
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
      const t = timers.find((x) => x.handle === handle);
      if (t) t.fired = true;
    }) as typeof clearTimeout;

    try {
      const setup = newIngestSetup();
      const { ready } = await setup.ingest.start(
        "m-hshake-timeout",
        TEST_BOT_TOKEN,
      );
      await flushMicrotasks();

      const bad = setup.server.connectBot({ authLine: null });
      await flushMicrotasks();

      const handshakeTimer = timers.find(
        (t) => !t.fired && t.ms === HANDSHAKE_TIMEOUT_MS,
      );
      expect(handshakeTimer).toBeDefined();
      handshakeTimer!.cb();
      handshakeTimer!.fired = true;

      await flushMicrotasks();
      expect(bad.destroyed).toBe(true);

      // Listener still open — the real bot can still show up after the
      // bogus peer timed out.
      setup.server.connectBot();
      await ready;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("forwards PCM bytes that arrived in the same TCP segment as the handshake newline", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-residual", TEST_BOT_TOKEN);
    await flushMicrotasks();

    // Single segment: AUTH line + newline + 3 PCM bytes. The ingest must
    // replay the residual PCM into the transcriber so we don't silently
    // drop the first frame when the bot pipes audio immediately after the
    // handshake.
    const combined = Buffer.concat([
      Buffer.from(`${AUDIO_INGEST_AUTH_PREFIX}${TEST_BOT_TOKEN}\n`, "utf8"),
      Buffer.from([0xde, 0xad, 0xbe]),
    ]);
    setup.server.connectBot({ authLine: null }).emitData(combined);
    await ready;

    expect(setup.session.audioChunks).toHaveLength(1);
    expect(setup.session.audioChunks[0]).toEqual(
      Buffer.from([0xde, 0xad, 0xbe]),
    );

    await setup.ingest.stop();
  });

  test("drops any connection that opens after a successful auth", async () => {
    const setup = newIngestSetup();
    const { ready } = await setup.ingest.start("m-second", TEST_BOT_TOKEN);
    await flushMicrotasks();

    setup.server.connectBot();
    await ready;

    // A second, fully valid handshake must still be dropped — the ingest
    // only wires the first accepted peer.
    const second = setup.server.connectBot();
    await flushMicrotasks();
    expect(second.destroyed).toBe(true);

    await setup.ingest.stop();
  });
});

// ---------------------------------------------------------------------------
// Host-backed factory — diarization wiring
//
// The default transcriber resolution path lives inside
// `createAudioIngest(host)` after the PR 10 migration: it reads the
// configured STT provider via `host.providers.stt.*` instead of importing
// the assistant-side resolver directly. These tests exercise the host
// factory's default path by supplying a stubbed `SkillHost`.
// ---------------------------------------------------------------------------

describe("createAudioIngest — default transcriber factory", () => {
  function buildStubHost(options: {
    resolver: (
      spec?: Record<string, unknown>,
    ) => StreamingTranscriber | null | Promise<StreamingTranscriber | null>;
    providerIds?: string[];
  }): SkillHost {
    const noop = () => {};
    const logger = { debug: noop, info: noop, warn: noop, error: noop };
    return {
      logger: { get: () => logger },
      config: {
        isFeatureFlagEnabled: () => false,
        getSection: () => undefined,
      },
      identity: {
        getAssistantName: () => undefined,
      },
      platform: {
        workspaceDir: () => "",
        vellumRoot: () => "",
        runtimeMode: () => "baremetal" as never,
      },
      providers: {
        llm: {
          getConfigured: async () => undefined,
          userMessage: () => undefined,
          extractToolUse: () => null,
          createTimeout: () => ({
            signal: new AbortController().signal,
            cleanup: () => {},
          }),
        },
        stt: {
          listProviderIds: () => options.providerIds ?? ["deepgram"],
          supportsBoundary: () => true,
          resolveStreamingTranscriber: (async (
            spec?: Record<string, unknown>,
          ) => options.resolver(spec)) as never,
        },
        tts: {
          get: () => undefined,
          resolveConfig: () => undefined,
        },
        secureKeys: {
          getProviderKey: async () => null,
        },
      },
      memory: {
        addMessage: (async () => undefined) as never,
        wakeAgentForOpportunity: async () => undefined,
      },
      events: {
        publish: async () => undefined,
        subscribe: () => ({ dispose: noop, active: true }),
        buildEvent: () => ({}) as never,
      },
      registries: {
        registerTools: noop,
        registerSkillRoute: () => ({}) as never,
        registerShutdownHook: noop,
      },
      speakers: {
        createTracker: () => ({}),
      },
    };
  }

  test("requests diarize: preferred and the meet-bot sample rate", async () => {
    const resolverCalls: Array<Record<string, unknown> | undefined> = [];
    const fakeSession = new FakeStreamingTranscriber();
    const host = buildStubHost({
      resolver: (spec) => {
        resolverCalls.push(spec);
        return fakeSession;
      },
    });

    const ingest = createAudioIngest(host)({
      listen: async () => new FakeAudioIngestServer(),
      botConnectTimeoutMs: 1_000,
    });

    // Kick off start(); we don't need it to resolve, just to reach the
    // resolver call. Attach a noop rejection handler so the bot-connect
    // timeout (never satisfied here) doesn't surface as an unhandled
    // rejection when the test finishes.
    const { ready } = await ingest.start("m-diarize", TEST_BOT_TOKEN);
    ready.catch(() => {});
    await flushMicrotasks();

    expect(resolverCalls).toHaveLength(1);
    const opts = resolverCalls[0];
    expect(opts).toBeDefined();
    expect((opts as { diarize?: string }).diarize).toBe("preferred");
    expect((opts as { sampleRate?: number }).sampleRate).toBeGreaterThan(0);

    await ingest.stop();
  });

  test("throws MeetAudioIngestError when the resolver returns null", async () => {
    const host = buildStubHost({
      resolver: () => null,
      providerIds: ["deepgram", "google-gemini"],
    });

    const make = createAudioIngest(host);

    await expect(
      make({ listen: async () => new FakeAudioIngestServer() }).start(
        "m-null",
        TEST_BOT_TOKEN,
      ),
    ).rejects.toBeInstanceOf(MeetAudioIngestError);
    await expect(
      make({ listen: async () => new FakeAudioIngestServer() }).start(
        "m-null2",
        TEST_BOT_TOKEN,
      ),
    ).rejects.toThrow(/configured STT provider is unusable/i);
  });
});
