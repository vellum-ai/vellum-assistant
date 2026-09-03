import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";

let ingressUrl: string | null = "http://localhost:8500";
let actorToken: string | null = "actor-jwt";
let pcmSupported = true;

mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedIngressUrl: () => ingressUrl,
  getSelfHostedActorToken: () => actorToken,
}));

// The real module imports an AudioWorklet asset via Vite's `?worker&url`
// suffix, which Bun's test runner can't resolve. The capture itself is
// injected through `captureFactory`, so only the named exports the module
// statically references need stubs.
mock.module("@/domains/chat/voice/live-voice/pcm-capture", () => ({
  isSupported: () => pcmSupported,
  LiveVoiceAudioCapture: class {
    constructor(_options: LiveVoiceAudioCaptureOptions) {}
    start(): Promise<LiveVoiceCaptureResult> {
      return Promise.resolve({ ok: true });
    }
    shutdown(): void {}
  },
}));

const { buildSttStreamWsUrl, startDictationStream } =
  await import("./dictation-stream");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWebSocket {
  url: string;
  readyState = 0; // CONNECTING
  sent: Array<string | ArrayBuffer> = [];
  closeCalls: Array<number | undefined> = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    this.readyState = 3; // CLOSED
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback(event);
    }
  }

  /** Simulate the server accepting the connection. */
  serverOpen(): void {
    this.readyState = 1; // OPEN
    this.emit("open", {});
  }

  /** Simulate a JSON event frame from the runtime session. */
  serverMessage(payload: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

function createCaptureFake({
  startResult = { ok: true } as LiveVoiceCaptureResult,
} = {}) {
  const calls = { started: 0, shutdown: 0 };
  let onChunk: ((buf: ArrayBuffer) => void) | null = null;
  const factory = (options: LiveVoiceAudioCaptureOptions) => {
    onChunk = options.onChunk;
    return {
      start: () => {
        calls.started += 1;
        return Promise.resolve(startResult);
      },
      shutdown: () => {
        calls.shutdown += 1;
      },
    };
  };
  return {
    factory,
    calls,
    pushChunk: (buf: ArrayBuffer) => onChunk?.(buf),
  };
}

async function startWithFakes(
  onPartial: (text: string) => void = () => undefined,
  captureFake = createCaptureFake(),
  {
    resolveWsUrl = () => Promise.resolve("ws://gateway.test/v1/stt/stream"),
  }: { resolveWsUrl?: (assistantId: string) => Promise<string> } = {},
) {
  let ws: FakeWebSocket | null = null;
  const handle = startDictationStream(
    { assistantId: "a1", onPartial },
    {
      resolveWsUrl,
      webSocketFactory: (url) => {
        ws = new FakeWebSocket(url);
        return ws as unknown as WebSocket;
      },
      captureFactory: captureFake.factory,
    },
  );
  if (!handle) {
    throw new Error("expected a stream handle");
  }
  // The URL is a promise away, and the socket is dialled once it settles.
  await flushMicrotasks();
  await flushMicrotasks();
  if (!ws) {
    throw new Error("expected the socket to be dialled once the URL resolved");
  }
  return { handle, ws: ws as FakeWebSocket, captureFake };
}

const flushMicrotasks = () => Promise.resolve();

afterEach(() => {
  ingressUrl = "http://localhost:8500";
  actorToken = "actor-jwt";
  pcmSupported = true;
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe("buildSttStreamWsUrl", () => {
  test("local __gateway proxy path dials the loopback gateway directly", () => {
    // The HTTP-only __gateway proxy can't carry a WS upgrade, so the dictation
    // stream must bypass it and hit 127.0.0.1:<port> directly (shared bypass).
    const url = new URL(
      buildSttStreamWsUrl({
        ingressUrl: "http://localhost:3000/assistant/__gateway/8500/",
        token: "tok en",
      }),
    );

    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("127.0.0.1:8500");
    expect(url.pathname).toBe("/v1/stt/stream");
    expect(url.searchParams.get("token")).toBe("tok en");
    expect(url.searchParams.get("mimeType")).toBe("audio/pcm");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
  });

  test("https ingress maps to wss and drops query/hash", () => {
    const url = new URL(
      buildSttStreamWsUrl({
        ingressUrl: "https://x.example.com?foo=1#bar",
        token: "t",
      }),
    );

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/stt/stream");
    expect(url.searchParams.get("foo")).toBeNull();
    expect(url.hash).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("startDictationStream", () => {
  test("returns null only where PCM capture is impossible", () => {
    pcmSupported = false;
    expect(
      startDictationStream({ assistantId: "a1", onPartial: () => undefined }),
    ).toBeNull();
  });

  /**
   * The socket is a token mint away for a managed assistant, and the speaker
   * is not waiting for it. Capture starts at once and what it hears is held
   * until the runtime says `ready`, so a dictation that begins the instant a
   * key goes down keeps its opening words.
   *
   * `ready` and not the socket opening: the runtime discards audio that
   * arrives before its transcriber is up, and that is the same moment it
   * sends `ready`. A frame released on `open` lands in that gap.
   */
  test("captures from the start and releases held audio on ready, not open", async () => {
    const { ws, captureFake } = await startWithFakes();
    const early = new ArrayBuffer(4);
    const between = new ArrayBuffer(6);
    const late = new ArrayBuffer(8);

    expect(captureFake.calls.started).toBe(1);
    captureFake.pushChunk(early);
    expect(ws.sent).toHaveLength(0);

    ws.serverOpen();
    captureFake.pushChunk(between);
    expect(ws.sent).toHaveLength(0);

    ws.serverMessage({ type: "ready" });
    expect(ws.sent).toEqual([early, between]);

    captureFake.pushChunk(late);
    expect(ws.sent).toEqual([early, between, late]);
  });

  /**
   * A session that dropped mid-way has a prefix of a transcript, and a prefix
   * handed over as the whole is inserted as the whole. The caller cannot tell
   * the two apart, so the stop resolves null for anything but a flush the
   * runtime finished, and the recording is transcribed some other way.
   */
  test("an unprompted close after finals resolves null, not the prefix", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();
    ws.serverMessage({ type: "ready" });
    ws.serverMessage({ type: "final", text: "the first half", seq: 0 });

    // The runtime went away on its own: nobody asked it to stop.
    ws.serverMessage({ type: "closed" });

    expect(await handle.stop()).toBeNull();
  });

  test("an error after finals resolves null, not the prefix", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();
    ws.serverMessage({ type: "ready" });
    ws.serverMessage({ type: "final", text: "the first half", seq: 0 });

    ws.serverMessage({
      type: "error",
      category: "provider-error",
      message: "gone",
    });

    expect(await handle.stop()).toBeNull();
  });

  /** And a socket that drops after a stop was sent is a failed flush, not a finished one. */
  test("a socket dropping after the stop resolves null", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();
    ws.serverMessage({ type: "ready" });
    ws.serverMessage({ type: "final", text: "words.", seq: 0 });

    const stopped = handle.stop();
    ws.close(1006);

    expect(await stopped).toBeNull();
  });

  test("composes partial and final transcripts as they arrive", async () => {
    const partials: string[] = [];
    const { handle, ws } = await startWithFakes((t) => partials.push(t));
    ws.serverOpen();

    expect(handle.isLive()).toBe(false);
    ws.serverMessage({ type: "ready", provider: "deepgram" });
    expect(handle.isLive()).toBe(true);

    ws.serverMessage({ type: "partial", text: "hello", seq: 0 });
    ws.serverMessage({ type: "partial", text: "hello wor", seq: 1 });
    ws.serverMessage({ type: "final", text: "hello world.", seq: 2 });
    ws.serverMessage({ type: "partial", text: "next bit", seq: 3 });

    expect(partials).toEqual([
      "hello",
      "hello wor",
      "hello world.",
      "hello world. next bit",
    ]);
  });

  /**
   * The provider flushes what it has left after the stop and the session
   * closes behind it. What the stop resolves with is everything committed by
   * then, which is a complete transcript of the recording.
   */
  test("stop() flushes, waits for the close, and resolves the committed transcript", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();
    ws.serverMessage({ type: "ready" });
    ws.serverMessage({ type: "final", text: "first sentence.", seq: 0 });

    const stopped = handle.stop();
    const stopFrames = ws.sent.filter(
      (frame) => typeof frame === "string" && frame.includes('"stop"'),
    );
    expect(stopFrames).toHaveLength(1);
    // Not yet: the provider is still flushing.
    expect(ws.closeCalls).toHaveLength(0);

    ws.serverMessage({ type: "final", text: "and the last.", seq: 1 });
    ws.serverMessage({ type: "closed" });

    expect(await stopped).toBe("first sentence. and the last.");
    expect(handle.isLive()).toBe(false);
  });

  test("stop() is idempotent and both calls settle on the same transcript", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();
    ws.serverMessage({ type: "ready" });
    ws.serverMessage({ type: "final", text: "words.", seq: 0 });

    const first = handle.stop();
    const second = handle.stop();
    ws.serverMessage({ type: "closed" });

    expect(await first).toBe("words.");
    expect(await second).toBe("words.");
    const stopFrames = ws.sent.filter(
      (frame) => typeof frame === "string" && frame.includes('"stop"'),
    );
    expect(stopFrames).toHaveLength(1);
  });

  /**
   * `null` is "nothing was heard", which a caller must be able to tell from
   * an empty transcript: a session that never went live has no opinion about
   * what was said, and the recording is transcribed some other way.
   */
  test("stop() resolves null when the session never went live", async () => {
    const { handle, ws } = await startWithFakes();
    ws.serverOpen();

    expect(await handle.stop()).toBeNull();
  });

  test("a structured error (e.g. provider without streaming) tears down silently", async () => {
    const partials: string[] = [];
    const { handle, ws, captureFake } = await startWithFakes((t) =>
      partials.push(t),
    );
    ws.serverOpen();
    ws.serverMessage({
      type: "error",
      category: "provider-error",
      message: "Streaming transcription is not supported",
      seq: 0,
    });

    expect(handle.isLive()).toBe(false);
    expect(captureFake.calls.shutdown).toBe(1);
    expect(await handle.stop()).toBeNull();

    ws.serverMessage({ type: "partial", text: "late", seq: 1 });
    expect(partials).toEqual([]);
  });

  /**
   * A paired ingress, a token the platform refused, an assistant with no way
   * in: each is a reason there is no stream rather than a fault. The handle
   * still exists, it just resolves to nothing, and batch dictation is
   * unaffected.
   */
  test("a URL that cannot be resolved tears down without dialling", async () => {
    let dialled = 0;
    const captureFake = createCaptureFake();
    const handle = startDictationStream(
      { assistantId: "a1", onPartial: () => undefined },
      {
        resolveWsUrl: () => Promise.reject(new Error("paired ingress")),
        webSocketFactory: () => {
          dialled += 1;
          throw new Error("unexpected dial");
        },
        captureFactory: captureFake.factory,
      },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(dialled).toBe(0);
    expect(captureFake.calls.shutdown).toBe(1);
    expect(await handle!.stop()).toBeNull();
  });

  /**
   * Capture fails before the URL has even resolved here, so the socket is
   * never dialled at all: a session already torn down has nothing to connect.
   */
  test("capture failure tears the session down without throwing", async () => {
    const captureFake = createCaptureFake({
      startResult: { ok: false, error: "permission-denied" },
    });
    let dialled = 0;
    const handle = startDictationStream(
      { assistantId: "a1", onPartial: () => undefined },
      {
        resolveWsUrl: () => Promise.resolve("ws://gateway.test/v1/stt/stream"),
        webSocketFactory: () => {
          dialled += 1;
          throw new Error("unexpected dial");
        },
        captureFactory: captureFake.factory,
      },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handle!.isLive()).toBe(false);
    expect(captureFake.calls.shutdown).toBe(1);
    expect(dialled).toBe(0);
    expect(await handle!.stop()).toBeNull();
  });

  /**
   * A hold short enough to end before the runtime is ready has its audio
   * still held and a runtime that ignores a stop. The stop goes out from the
   * ready handler, right behind the audio it asks the runtime to finish,
   * rather than being lost and the hold waiting out the flush timeout.
   */
  test("a stop before ready is sent once ready arrives, after the held audio", async () => {
    const { handle, ws, captureFake } = await startWithFakes();
    const early = new ArrayBuffer(4);
    ws.serverOpen();
    captureFake.pushChunk(early);

    const stopped = handle.stop();
    expect(ws.sent).toHaveLength(0);

    ws.serverMessage({ type: "ready" });
    expect(ws.sent[0]).toBe(early);
    expect(ws.sent[1]).toContain('"stop"');

    ws.serverMessage({ type: "final", text: "brief.", seq: 0 });
    ws.serverMessage({ type: "closed" });
    expect(await stopped).toBe("brief.");
  });

  /**
   * Shorter still: the hold ends while the token is still being minted, so
   * there is no socket to send anything on. The dial goes ahead anyway, and
   * the stop follows the held audio out once the runtime is ready.
   */
  test("a stop before the socket is dialled still reaches the runtime", async () => {
    let resolveUrl: (url: string) => void = () => undefined;
    const captureFake = createCaptureFake();
    let ws: FakeWebSocket | null = null;
    const handle = startDictationStream(
      { assistantId: "a1", onPartial: () => undefined },
      {
        resolveWsUrl: () =>
          new Promise<string>((resolve) => {
            resolveUrl = resolve;
          }),
        webSocketFactory: (url) => {
          ws = new FakeWebSocket(url);
          return ws as unknown as WebSocket;
        },
        captureFactory: captureFake.factory,
      },
    );
    await flushMicrotasks();
    const early = new ArrayBuffer(4);
    captureFake.pushChunk(early);

    const stopped = handle!.stop();
    expect(ws).toBeNull();
    // The mic is released at the stop, and audio arriving after it stays out
    // of the transcript, however long the dial takes to catch up.
    expect(captureFake.calls.shutdown).toBe(1);
    captureFake.pushChunk(new ArrayBuffer(4));

    resolveUrl("ws://gateway.test/v1/stt/stream");
    await flushMicrotasks();
    await flushMicrotasks();
    const socket = ws as FakeWebSocket | null;
    if (!socket) {
      throw new Error("expected the socket to be dialled after the stop");
    }
    socket.serverOpen();
    expect(socket.sent).toHaveLength(0);
    socket.serverMessage({ type: "ready" });
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toBe(early);
    expect(socket.sent[1]).toContain('"stop"');

    socket.serverMessage({ type: "final", text: "hi.", seq: 0 });
    socket.serverMessage({ type: "closed" });
    expect(await stopped).toBe("hi.");
  });
});
