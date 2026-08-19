import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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

const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);
const { buildWatchStreamWsUrl, stopWatch, toggleWatch, useWatchStore } =
  await import("./watch-controller");

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

  /** Simulate the gateway accepting the connection. */
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
  const calls = { started: 0, shutdown: 0, flushed: 0 };
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
      flush: () => {
        calls.flushed += 1;
      },
    };
  };
  return {
    factory,
    calls,
    pushChunk: (buf: ArrayBuffer) => onChunk?.(buf),
  };
}

/** Every socket the module has opened this test, most recent last. */
let sockets: FakeWebSocket[] = [];
let capture = createCaptureFake();

/** Toggle through the fakes, so no test touches a real socket or the mic. */
const toggle = () => {
  toggleWatch({
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    captureFactory: capture.factory,
  });
};

/** The socket the running session is on. */
const socket = (): FakeWebSocket => {
  const last = sockets.at(-1);
  if (!last) {
    throw new Error("Expected a socket to have been opened");
  }
  return last;
};

/** Start a session and let the gateway accept it, which is what starts the mic. */
const startRunning = async () => {
  toggle();
  socket().serverOpen();
  await Promise.resolve();
};

beforeEach(() => {
  ingressUrl = "http://localhost:8500";
  actorToken = "actor-jwt";
  pcmSupported = true;
  sockets = [];
  capture = createCaptureFake();
  useLiveVoiceStore.setState({ state: "idle" });
});

afterEach(() => {
  // Whatever a case left running, so the module-level slot never leaks into
  // the next one.
  stopWatch();
});

describe("the watch stream URL", () => {
  test("carries the actor token and the capture's audio format", () => {
    const url = new URL(
      buildWatchStreamWsUrl({
        ingressUrl: "https://gateway.example.com",
        token: "actor-jwt",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/watch/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
    expect(url.searchParams.get("mimeType")).toBe("audio/pcm");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
  });
});

describe("toggling a watch session", () => {
  test("opens the stream and starts the microphone", async () => {
    await startRunning();

    expect(sockets).toHaveLength(1);
    expect(socket().url).toContain("/v1/watch/stream");
    expect(capture.calls.started).toBe(1);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("sends the captured audio as binary frames", async () => {
    await startRunning();

    capture.pushChunk(new ArrayBuffer(8));

    expect(socket().sent).toHaveLength(1);
    expect(socket().sent[0]).toBeInstanceOf(ArrayBuffer);
  });

  /**
   * The second press is the way out of a session, which is the whole of what
   * makes this one control rather than two. A press that opened a second
   * socket would also open a second microphone, and the first would be left
   * running with nothing able to reach it.
   */
  test("stops on the second press rather than starting a second session", async () => {
    await startRunning();

    toggle();

    expect(sockets).toHaveLength(1);
    expect(capture.calls.started).toBe(1);
    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("drains the capture and asks the runtime to wrap up before closing", async () => {
    await startRunning();

    toggle();

    expect(capture.calls.flushed).toBe(1);
    expect(socket().sent).toEqual([JSON.stringify({ type: "stop" })]);
  });

  test("starts again after a session has ended", async () => {
    await startRunning();
    toggle();

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /**
   * One microphone, one owner. Both sessions capture from the device the
   * machine has exactly one of, and the call is the one the user is already
   * in, so the press is spent rather than queued behind it.
   */
  test("refuses to start while a live-voice call is running", () => {
    useLiveVoiceStore.setState({ state: "listening" });

    toggle();

    expect(sockets).toHaveLength(0);
    expect(capture.calls.started).toBe(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("starts once the call has ended", async () => {
    useLiveVoiceStore.setState({ state: "listening" });
    toggle();
    useLiveVoiceStore.setState({ state: "idle" });

    await startRunning();

    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("opens nothing without a self-hosted ingress to reach", () => {
    ingressUrl = null;

    toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("opens nothing without an actor token to authenticate with", () => {
    actorToken = null;

    toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("opens nothing where the capture pipeline cannot run", () => {
    pcmSupported = false;

    toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });
});

/**
 * Teardown, from every direction it can arrive: the caller, the runtime, and
 * the transport. A session that survived any of them would leave the
 * microphone open with nothing left able to close it.
 */
describe("tearing a watch session down", () => {
  test("closes the socket and releases the microphone", async () => {
    await startRunning();

    stopWatch();

    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("says nothing when no session is running", () => {
    stopWatch();

    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("is idempotent, so a second teardown adds nothing", async () => {
    await startRunning();

    stopWatch();
    stopWatch();

    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
  });

  test("ends the session when the runtime reports an error", async () => {
    await startRunning();

    socket().serverMessage({ type: "error", message: "no host client" });

    expect(capture.calls.shutdown).toBe(1);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("ends the session when the runtime closes it", async () => {
    await startRunning();

    socket().serverMessage({ type: "closed" });

    expect(capture.calls.shutdown).toBe(1);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("ends the session when the socket drops", async () => {
    await startRunning();

    socket().emit("close", { code: 1006 });

    expect(capture.calls.shutdown).toBe(1);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * A denied microphone leaves nothing to narrate over, so the session ends
   * rather than sitting open on a socket carrying silence.
   */
  test("ends the session when the microphone is refused", async () => {
    capture = createCaptureFake({
      startResult: { ok: false, error: "permission-denied" },
    });

    await startRunning();

    expect(useWatchStore.getState().watching).toBe(false);
  });

  /** The next press is a start again, not a stop of something already gone. */
  test("frees the slot, so the next press opens a new session", async () => {
    await startRunning();
    socket().emit("close", { code: 1006 });

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });
});
