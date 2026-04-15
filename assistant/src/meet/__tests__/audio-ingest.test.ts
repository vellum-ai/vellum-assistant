/**
 * Unit tests for {@link MeetAudioIngest}.
 *
 * These tests exercise the ingest in isolation by injecting fake factories
 * for both the Deepgram session and the Unix-socket server. No real network
 * or filesystem socket is opened.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  BOT_CONNECT_TIMEOUT_MS,
  type DeepgramIngestOptions,
  MeetAudioIngest,
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
 * Fake Deepgram streaming session. Records every audio chunk it receives
 * and exposes an `emit` helper so tests can inject synthetic transcript
 * events.
 */
class FakeDeepgramSession implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  readonly audioChunks: Buffer[] = [];
  startCalls = 0;
  stopCalls = 0;
  started = false;
  options: DeepgramIngestOptions;

  private listener: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(options: DeepgramIngestOptions) {
    this.options = options;
  }

  async start(
    onEvent: (event: SttStreamServerEvent) => void,
  ): Promise<void> {
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

function newIngestSetup(): {
  server: FakeUnixSocketServer;
  session: FakeDeepgramSession;
  ingest: MeetAudioIngest;
  listenCalls: string[];
  deepgramCalls: DeepgramIngestOptions[];
} {
  const server = new FakeUnixSocketServer();
  let session: FakeDeepgramSession | null = null;
  const listenCalls: string[] = [];
  const deepgramCalls: DeepgramIngestOptions[] = [];
  const ingest = new MeetAudioIngest({
    createDeepgramSession: (opts) => {
      deepgramCalls.push(opts);
      session = new FakeDeepgramSession(opts);
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
      if (!session) throw new Error("Deepgram session not created yet");
      return session;
    },
    ingest,
    listenCalls,
    deepgramCalls,
  } as unknown as {
    server: FakeUnixSocketServer;
    session: FakeDeepgramSession;
    ingest: MeetAudioIngest;
    listenCalls: string[];
    deepgramCalls: DeepgramIngestOptions[];
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
  test("opens Deepgram with smart-format + interim, opens socket server, resolves on bot connect", async () => {
    const setup = newIngestSetup();

    const startPromise = setup.ingest.start(
      "m1",
      "/tmp/fake-audio.sock",
      "dg-api-key",
    );

    // The listen factory was called with the provided path.
    // The ingest awaits `listen()` before registering its connection
    // listener, so we need to let microtasks run before connecting.
    await Promise.resolve();
    await Promise.resolve();

    expect(setup.listenCalls).toEqual(["/tmp/fake-audio.sock"]);
    expect(setup.deepgramCalls).toHaveLength(1);
    expect(setup.deepgramCalls[0]).toEqual({
      apiKey: "dg-api-key",
      smartFormatting: true,
      interimResults: true,
    });

    // Simulate the bot dialing in.
    setup.server.connectBot();
    await startPromise;

    expect(setup.session.started).toBe(true);
  });

  test("rejects when Deepgram fails to connect (and does not open the socket)", async () => {
    const listen = mock(async () => new FakeUnixSocketServer());
    const failingFactory = () => ({
      providerId: "deepgram" as const,
      boundaryId: "daemon-streaming" as const,
      start: async () => {
        throw new Error("dg auth failed");
      },
      sendAudio: () => {},
      stop: () => {},
    });

    const ingest = new MeetAudioIngest({
      createDeepgramSession: failingFactory,
      listen,
    });

    await expect(
      ingest.start("m1", "/tmp/x.sock", "bad-key"),
    ).rejects.toThrow(/dg auth failed/);
    expect(listen).toHaveBeenCalledTimes(0);
  });

  test("rejects and tears Deepgram down when the socket server fails to open", async () => {
    const sessionsStopped: number[] = [];
    let session: FakeDeepgramSession | null = null;
    const ingest = new MeetAudioIngest({
      createDeepgramSession: (opts) => {
        session = new FakeDeepgramSession(opts);
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

    await expect(
      ingest.start("m1", "/tmp/x.sock", "k"),
    ).rejects.toThrow(/EADDRINUSE/);
    expect(session).not.toBeNull();
    expect(sessionsStopped).toHaveLength(1);
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
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
      ((cb: () => void, ms: number) => {
        const handle = Symbol(`timer-${nextId++}`);
        timers.push({ handle, cb, ms, fired: false });
        return handle as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
      ((handle: unknown) => {
        const t = timers.find((t) => t.handle === handle);
        if (t) t.fired = true; // "cleared" is effectively never-fire
      }) as typeof clearTimeout;

    try {
      const setup = newIngestSetup();
      const startPromise = setup.ingest.start(
        "m1",
        "/tmp/timeout.sock",
        "dg-key",
      );

      // Let microtasks settle so the ingest has called `listen()` and
      // registered its watchdog.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

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
  test("forwards PCM bytes from the bot to Deepgram", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start(
      "m-forward",
      "/tmp/audio.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();

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

  test("dispatches partial Deepgram events as non-final transcript chunks", async () => {
    const setup = newIngestSetup();
    const captured: Array<Parameters<typeof dispatchMock>[1]> = [];
    const dispatchMock = mock((_meetingId: string, event: unknown) => {
      captured.push(event as (typeof captured)[number]);
    });
    // Register a handler so dispatch actually fires.
    getMeetSessionEventRouter().register("m-partial", (e) =>
      dispatchMock("m-partial", e),
    );

    const startPromise = setup.ingest.start(
      "m-partial",
      "/tmp/partial.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
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

  test("dispatches final Deepgram events as final transcript chunks", async () => {
    const setup = newIngestSetup();
    const captured: Array<unknown> = [];
    getMeetSessionEventRouter().register("m-final", (e) => captured.push(e));

    const startPromise = setup.ingest.start(
      "m-final",
      "/tmp/final.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
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

  test("does not dispatch non-transcript events (error / closed)", async () => {
    const setup = newIngestSetup();
    const captured: Array<unknown> = [];
    getMeetSessionEventRouter().register("m-ignore", (e) => captured.push(e));

    const startPromise = setup.ingest.start(
      "m-ignore",
      "/tmp/ignore.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
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
  test("destroys connection, stops Deepgram, closes server", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start(
      "m-stop",
      "/tmp/stop.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
    const conn = setup.server.connectBot();
    await startPromise;

    await setup.ingest.stop();

    expect(conn.destroyed).toBe(true);
    expect(setup.session.stopCalls).toBe(1);
    expect(setup.server.closed).toBe(true);
  });

  test("is idempotent", async () => {
    const setup = newIngestSetup();
    const startPromise = setup.ingest.start(
      "m-idem",
      "/tmp/idem.sock",
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
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
      "dg",
    );
    await Promise.resolve();
    await Promise.resolve();
    const conn = setup.server.connectBot();
    await startPromise;

    await setup.ingest.stop();
    conn.emitData(Buffer.from([0x0a, 0x0b]));

    // Stop was synchronous wrt. the connection — any late data is dropped.
    expect(setup.session.audioChunks).toHaveLength(0);
  });
});
