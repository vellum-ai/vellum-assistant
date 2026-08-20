import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import type * as SelfHostedConnection from "@/lib/self-hosted/connection";

let ingressUrl: string | null = "http://localhost:8500";
let actorToken: string | null = "actor-jwt";
let pcmSupported = true;

mock.module(
  "@/lib/self-hosted/connection",
  (): typeof SelfHostedConnection => ({
    getSelfHostedIngressUrl: () => ingressUrl,
    getSelfHostedActorToken: () => actorToken,
    // Unused here, and stubbed rather than omitted: the resolved-assistants
    // store's own imports reach this module for it, and a missing export is a
    // load-time failure for the whole file.
    setSelfHostedConnection: () => undefined,
  }),
);

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

/**
 * The active-assistant store, stood in for so the test can see the session's
 * subscription come and go. A leaked listener is invisible against the real
 * store (teardown is idempotent, so a stale one fires harmlessly and
 * accumulates one listener per session for the life of the page), and the
 * subscription's lifetime is exactly what binds a session to its assistant.
 */
let activeAssistantId: string | null = null;
const assistantListeners = new Set<
  (state: { activeAssistantId: string | null }) => void
>();

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ activeAssistantId }),
    subscribe: (
      listener: (state: { activeAssistantId: string | null }) => void,
    ) => {
      assistantListeners.add(listener);
      return () => {
        assistantListeners.delete(listener);
      };
    },
  },
}));

const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { MIN_VERSION } = await import("@/lib/backwards-compat/watch-sessions");
const { buildWatchStreamWsUrl, stopWatch, toggleWatch, useWatchStore } =
  await import("./watch-controller");

/** The assistant every session in this file is started against. */
const ASSISTANT_ID = "asst-owner";

/** Make `assistantId` the active one, on a version that serves the route. */
const activate = (
  assistantId: string | null,
  version: string | null = MIN_VERSION,
) => {
  activeAssistantId = assistantId;
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, assistantId);
  for (const listener of [...assistantListeners]) {
    listener({ activeAssistantId });
  }
};

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
const toggle = (readyTimeoutMs = 50): Promise<void> => {
  return toggleWatch({
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    captureFactory: capture.factory,
    readyTimeoutMs,
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

/** Open the socket and stop there, which is a session still pending. */
const startPending = async (readyTimeoutMs?: number) => {
  await toggle(readyTimeoutMs);
  socket().serverOpen();
  await Promise.resolve();
};

/** Answer `ready` on the pending session, which starts the flag and the mic. */
const serverReady = async () => {
  socket().serverMessage({
    type: "ready",
    sessionId: "sess-1",
    conversationId: "conv-1",
  });
  await Promise.resolve();
};

/** Take a session all the way to running: pending, then answered. */
const startRunning = async (readyTimeoutMs?: number) => {
  await startPending(readyTimeoutMs);
  await serverReady();
};

/** Record every write to the watch flag for the duration of `run`. */
const flagEmissions = async (run: () => Promise<void>): Promise<boolean[]> => {
  const seen: boolean[] = [];
  const unsubscribe = useWatchStore.subscribe((state) => {
    seen.push(state.watching);
  });
  await run();
  unsubscribe();
  return seen;
};

/** Let a bounded timer that is shorter than this fire. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  ingressUrl = "http://localhost:8500";
  actorToken = "actor-jwt";
  pcmSupported = true;
  sockets = [];
  capture = createCaptureFake();
  useLiveVoiceStore.setState({ state: "idle" });
  activate(ASSISTANT_ID);
});

afterEach(() => {
  // Whatever a case left running, so the module-level slot never leaks into
  // the next one.
  stopWatch();
  useAssistantIdentityStore.getState().clearIdentity();
  activeAssistantId = null;
  assistantListeners.clear();
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

    await toggle();

    expect(sockets).toHaveLength(1);
    expect(capture.calls.started).toBe(1);
    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("drains the capture and asks the runtime to wrap up before closing", async () => {
    await startRunning();

    await toggle();

    expect(capture.calls.flushed).toBe(1);
    expect(socket().sent).toEqual([JSON.stringify({ type: "stop" })]);
  });

  test("starts again after a session has ended", async () => {
    await startRunning();
    await toggle();

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /**
   * One microphone, one owner. Both sessions capture from the device the
   * machine has exactly one of, and the call is the one the user is already
   * in, so the press is spent rather than queued behind it.
   */
  test("refuses to start while a live-voice call is running", async () => {
    useLiveVoiceStore.setState({ state: "listening" });

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(capture.calls.started).toBe(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("starts once the call has ended", async () => {
    useLiveVoiceStore.setState({ state: "listening" });
    await toggle();
    useLiveVoiceStore.setState({ state: "idle" });

    await startRunning();

    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("opens nothing without a self-hosted ingress to reach", async () => {
    ingressUrl = null;

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("opens nothing without an actor token to authenticate with", async () => {
    actorToken = null;

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("opens nothing where the capture pipeline cannot run", async () => {
    pcmSupported = false;

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });
});

/**
 * The version gate, which decides whether there is a route to open at all.
 *
 * Refused before any state moves, because the alternative is the press
 * flipping `watching` and then failing the handshake: the surface lights its
 * capture ring for a session that never existed, which is the indicator lying.
 */
describe("starting against an assistant that cannot serve the stream", () => {
  test("opens nothing on an assistant that predates the route", async () => {
    activate(ASSISTANT_ID, "0.11.3");

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(capture.calls.started).toBe(0);
  });

  /**
   * The flag is the whole point. A press that lit the ring and then went dark
   * a round trip later is the failure this gate exists to remove.
   */
  test("never flips the watching flag on the way to refusing", async () => {
    activate(ASSISTANT_ID, "0.11.3");

    const seen = await flagEmissions(async () => {
      await toggle();
    });

    expect(seen).toEqual([]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * The case the resolution exists for. The gate reads `false` until the
   * identity fetch lands, so a press inside that window would refuse an
   * assistant that does support watching if it read the snapshot directly.
   *
   * Resolved by seeding the version rather than by letting the wait time out,
   * which takes five seconds and is the gate module's own test to write.
   */
  test("waits for a version still in flight rather than refusing the press", async () => {
    activate(ASSISTANT_ID, null);

    const pressed = toggle();
    activate(ASSISTANT_ID);
    await pressed;

    expect(sockets).toHaveLength(1);
  });

  test("opens nothing with no active assistant to start against", async () => {
    activate(null);

    await toggle();

    expect(sockets).toHaveLength(0);
  });

  test("opens the stream once the assistant is new enough", async () => {
    activate(ASSISTANT_ID, "0.12.0");

    await startRunning();

    expect(sockets).toHaveLength(1);
    expect(useWatchStore.getState().watching).toBe(true);
  });
});

/**
 * A start that is still resolving the version gate.
 *
 * The gate waits for the identity fetch, which on a cold app can be seconds.
 * A press in that window is the user changing their mind, and it has to reach
 * something: without a registered attempt it finds no session, does nothing,
 * and the resolution goes on to start the session that was just cancelled.
 */
describe("cancelling a start that has not opened a socket yet", () => {
  /** Press once with the version unknown, leaving the gate mid-resolution. */
  const pressWithVersionPending = () => {
    activate(ASSISTANT_ID, null);
    return toggle();
  };

  /**
   * The second press is deliberately not awaited before the version lands.
   * Awaiting it would let an unregistered attempt queue behind the same gate
   * and time out alongside the first, which looks like a cancellation from the
   * outside and would pass whether or not anything was actually cancelled.
   * Left unawaited, an attempt nothing can reach starts a second session here.
   */
  test("cancels on a second press before the version lands", async () => {
    const seen = await flagEmissions(async () => {
      const pressed = pressWithVersionPending();
      const second = toggle();

      activate(ASSISTANT_ID);
      await pressed;
      await second;
    });

    expect(sockets).toHaveLength(0);
    expect(capture.calls.started).toBe(0);
    expect(seen).toEqual([]);
  });

  test("is reachable by stopWatch, which is what teardown uses", async () => {
    const pressed = pressWithVersionPending();

    stopWatch();
    activate(ASSISTANT_ID);
    await pressed;

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /** The attempt occupies the slot, which is what the stop edge reaches. */
  test("frees the slot on cancelling, so a later press starts cleanly", async () => {
    const pressed = pressWithVersionPending();
    const second = toggle();
    activate(ASSISTANT_ID);
    await pressed;
    await second;

    await startRunning();

    expect(sockets).toHaveLength(1);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /** Nothing was cancelled, so the press it was waiting on still lands. */
  test("starts normally when nobody cancels it", async () => {
    const pressed = pressWithVersionPending();
    activate(ASSISTANT_ID);
    await pressed;
    socket().serverOpen();
    await serverReady();

    expect(sockets).toHaveLength(1);
    expect(useWatchStore.getState().watching).toBe(true);
  });
});

/**
 * A socket is not a session.
 *
 * The gateway accepts the downstream upgrade before it dials the runtime, so a
 * local open proves only that a proxy answered. The runtime's `ready` frame is
 * the first word that a session exists, and until it arrives the companion
 * must show nothing.
 *
 * Every case here asserts on the writes to the flag rather than on its final
 * value: a flag that goes true and back is exactly the bug, and a final read
 * cannot see it.
 */
describe("a watch session between the socket and the runtime", () => {
  test("shows nothing while the session is still pending", async () => {
    const seen = await flagEmissions(async () => {
      await startPending();
    });

    expect(seen).toEqual([]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * The microphone waits for `ready` alongside the flag. Opening it first
   * would put the pair the other way round: audio flowing with nothing on
   * screen saying so, which is the same failure with the signs swapped.
   */
  test("leaves the microphone closed while the session is pending", async () => {
    await startPending();

    expect(capture.calls.started).toBe(0);
  });

  test("flips the flag when the runtime says the session exists", async () => {
    const seen = await flagEmissions(async () => {
      await startRunning();
    });

    expect(seen).toEqual([true]);
    expect(useWatchStore.getState().watching).toBe(true);
    expect(capture.calls.started).toBe(1);
  });

  /**
   * A close before `ready` is a failed start, not a session that stopped, so
   * there is no claim to give up and nothing to publish.
   */
  test("never flips the flag when the socket closes before ready", async () => {
    const seen = await flagEmissions(async () => {
      await startPending();
      socket().emit("close", { code: 1006 });
    });

    expect(seen).toEqual([]);
    expect(capture.calls.shutdown).toBe(1);
  });

  test("never flips the flag when the runtime errors before ready", async () => {
    const seen = await flagEmissions(async () => {
      await startPending();
      socket().serverMessage({
        type: "error",
        category: "session-error",
        message: "A watch session is already running.",
      });
    });

    expect(seen).toEqual([]);
    expect(capture.calls.shutdown).toBe(1);
  });

  /**
   * A gateway that accepts and then never hears from the runtime would
   * otherwise leave the session pending for as long as the page lives.
   */
  test("gives up on a session the runtime never answers for", async () => {
    const seen = await flagEmissions(async () => {
      await startPending(5);
      await wait(30);
    });

    expect(seen).toEqual([]);
    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
  });

  test("frees the slot on giving up, so the next press opens a new session", async () => {
    await startPending(5);
    await wait(30);

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("does not give up on a session the runtime did answer for", async () => {
    await startRunning(5);

    await wait(30);

    expect(useWatchStore.getState().watching).toBe(true);
    expect(capture.calls.shutdown).toBe(0);
  });

  /**
   * The stop edge has to reach a pending session too. A second press is the
   * user cancelling an attempt that is going nowhere, and stranding it would
   * leave a socket open that nothing can reach.
   */
  test("cancels a pending session on the second press", async () => {
    const seen = await flagEmissions(async () => {
      await startPending();
      await toggle();
    });

    expect(seen).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(capture.calls.shutdown).toBe(1);
  });

  test("starts a fresh session after a cancelled one", async () => {
    await startPending();
    await toggle();

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });
});

/**
 * The session belongs to the assistant it was started for.
 *
 * Switching assistants leaves this layout mounted and rewrites the active
 * identity in place, so without this the socket would stay open to the
 * previous assistant while the surface drew the new one's name beside a flag
 * that read as the new one's.
 */
describe("a watch session across an assistant switch", () => {
  test("ends when another assistant becomes the active one", async () => {
    await startRunning();

    activate("asst-other");

    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /** Ambiguous rather than benign, so the safe reading is to stop capturing. */
  test("ends when no assistant is active any more", async () => {
    await startRunning();

    activate(null);

    expect(capture.calls.shutdown).toBe(1);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("survives a write that leaves the same assistant active", async () => {
    await startRunning();

    activate(ASSISTANT_ID);

    expect(capture.calls.shutdown).toBe(0);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /**
   * The subscription lives exactly as long as the session does. Left behind it
   * fires harmlessly, because teardown is idempotent, and accumulates one
   * listener per session for the life of the page.
   */
  test("stops listening for switches once the session is over", async () => {
    await startRunning();
    expect(assistantListeners.size).toBe(1);

    stopWatch();

    expect(assistantListeners.size).toBe(0);
  });

  test("leaves nothing behind across repeated sessions", async () => {
    await startRunning();
    stopWatch();
    await startRunning();
    stopWatch();

    expect(assistantListeners.size).toBe(0);
  });

  test("starts again against whichever assistant is active now", async () => {
    await startRunning();
    activate("asst-other");

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
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
