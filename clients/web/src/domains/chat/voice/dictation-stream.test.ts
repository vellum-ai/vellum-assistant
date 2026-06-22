import { afterEach, describe, expect, mock, test } from "bun:test";

import type { LiveVoiceAudioCaptureOptions, LiveVoiceCaptureResult } from "@/domains/chat/voice/live-voice/pcm-capture";

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

const { buildSttStreamWsUrl, startDictationStream } = await import(
  "./dictation-stream"
);

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

function startWithFakes(
  onPartial: (text: string) => void = () => undefined,
  captureFake = createCaptureFake(),
) {
  let ws: FakeWebSocket | null = null;
  const handle = startDictationStream(
    { onPartial },
    {
      webSocketFactory: (url) => {
        ws = new FakeWebSocket(url);
        return ws as unknown as WebSocket;
      },
      captureFactory: captureFake.factory,
    },
  );
  if (!handle || !ws) throw new Error("expected stream to start");
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
  test("http ingress with a path prefix maps to ws and keeps the prefix", () => {
    const url = new URL(
      buildSttStreamWsUrl({
        ingressUrl: "http://localhost:3000/assistant/__gateway/8500/",
        token: "tok en",
      }),
    );

    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/assistant/__gateway/8500/v1/stt/stream");
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
  test("returns null without a self-hosted ingress, token, or worklet support", () => {
    ingressUrl = null;
    expect(startDictationStream({ onPartial: () => undefined })).toBeNull();

    ingressUrl = "http://localhost:8500";
    actorToken = null;
    expect(startDictationStream({ onPartial: () => undefined })).toBeNull();

    actorToken = "actor-jwt";
    pcmSupported = false;
    expect(startDictationStream({ onPartial: () => undefined })).toBeNull();
  });

  test("starts capture on open and composes partial/final transcripts", async () => {
    const partials: string[] = [];
    const { handle, ws, captureFake } = startWithFakes((t) => partials.push(t));

    ws.serverOpen();
    await flushMicrotasks();
    expect(captureFake.calls.started).toBe(1);

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

  test("forwards PCM chunks only while the socket is open", () => {
    const { handle, ws, captureFake } = startWithFakes();
    const chunk = new ArrayBuffer(4);

    captureFake.pushChunk(chunk);
    expect(ws.sent).toHaveLength(0);

    ws.serverOpen();
    captureFake.pushChunk(chunk);
    expect(ws.sent).toEqual([chunk]);

    handle.stop();
    captureFake.pushChunk(chunk);
    expect(ws.sent.filter((s) => s === chunk)).toHaveLength(1);
  });

  test("a structured error (e.g. provider without streaming) tears down silently", () => {
    const partials: string[] = [];
    const { handle, ws, captureFake } = startWithFakes((t) => partials.push(t));

    ws.serverOpen();
    ws.serverMessage({
      type: "error",
      category: "provider-error",
      message: "Streaming transcription is not supported",
      seq: 0,
    });

    expect(handle.isLive()).toBe(false);
    expect(captureFake.calls.shutdown).toBe(1);

    ws.serverMessage({ type: "partial", text: "late", seq: 1 });
    expect(partials).toEqual([]);
  });

  test("stop() sends the stop frame once and closes; idempotent", () => {
    const { handle, ws } = startWithFakes();
    ws.serverOpen();

    handle.stop();
    handle.stop();

    const stopFrames = ws.sent.filter(
      (frame) => typeof frame === "string" && frame.includes('"stop"'),
    );
    expect(stopFrames).toHaveLength(1);
    expect(ws.closeCalls).toHaveLength(1);
    expect(handle.isLive()).toBe(false);
  });

  test("capture failure tears the session down without throwing", async () => {
    const captureFake = createCaptureFake({
      startResult: { ok: false, error: "permission-denied" },
    });
    const { handle, ws } = startWithFakes(() => undefined, captureFake);

    ws.serverOpen();
    await flushMicrotasks();

    expect(handle.isLive()).toBe(false);
    expect(captureFake.calls.shutdown).toBe(1);
  });
});
