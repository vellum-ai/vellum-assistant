import { LIVE_VOICE_AUDIO_FORMAT_PARAMS } from "@/domains/chat/voice/live-voice/protocol";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

let ingressUrl: string | null = "http://localhost:8500";
let actorToken: string | null = "actor-jwt";
let pcmSupported = true;

/**
 * Publish the two variables above into the real connection module.
 *
 * The real module rather than a `mock.module` stand-in, because that
 * replacement outlives this file: bun shares a process across test files, and
 * `connection.test.ts` primes the same module through `setSelfHostedConnection`
 * to test the transport rules. A stand-in here silently turns that call into a
 * no-op there.
 */
const applyConnection = (): void => {
  setSelfHostedConnection({ url: ingressUrl, token: actorToken });
};

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
 * The velay token mint, stood in for so the managed path can be exercised
 * without an HTTP round trip.
 *
 * Only the mint is replaced. Everything else in the connection module — both
 * URL builders, the paired-ingress predicate, the error types — stays real, so
 * the URLs these tests assert on are the ones the app would actually dial
 * rather than a fake's idea of them.
 */
const realConnection =
  await import("@/domains/chat/voice/live-voice/connection");

/** Assistant ids the mint was called for, in order. */
let mintCalls: string[] = [];
/** Set to null to make the platform refuse the mint. */
let mintedToken: string | null = "velay-token";
/** Held open by a test that needs a press to land mid-mint. */
let mintGate: Promise<void> | null = null;

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

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { MIN_VERSION: RETRO_MIN_VERSION } =
  await import("@/lib/backwards-compat/watch-retro-completion");
const {
  buildWatchStreamWsUrl,
  isWatchSessionActive,
  resolveWatchStreamWsUrl,
  stopWatch,
  toggleWatch,
  useWatchStore,
} = await import("./watch-controller");
const { clearWatchRetro, useWatchRetroStore } = await import("./watch-retro");

/**
 * Live-voice subscriptions, counted.
 *
 * A leaked one is invisible against the real store: teardown is idempotent, so
 * a stale listener fires harmlessly and accumulates one listener per session
 * for the life of the page. Spying on the real `subscribe` rather than mocking
 * the module keeps the real `isLiveVoiceSessionActive` and the real state
 * machine, which are the things these cases are actually driving.
 */
let liveVoiceListeners = 0;
const realLiveVoiceSubscribe = useLiveVoiceStore.subscribe.bind(
  useLiveVoiceStore,
) as typeof useLiveVoiceStore.subscribe;
useLiveVoiceStore.subscribe = ((
  listener: Parameters<typeof realLiveVoiceSubscribe>[0],
) => {
  liveVoiceListeners += 1;
  const unsubscribe = realLiveVoiceSubscribe(listener);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      liveVoiceListeners -= 1;
    }
    unsubscribe();
  };
}) as typeof useLiveVoiceStore.subscribe;

/** The assistant every session in this file is started against. */
const ASSISTANT_ID = "asst-owner";

/**
 * Make `assistantId` the active one, on a version that serves the route.
 *
 * The default is the later of the two watch floors, so a case that says nothing
 * about versions gets an assistant that both serves the stream and announces
 * its retrospectives. The stream floor on its own is a real assistant too, and
 * the band between them has its own case below.
 */
const activate = (
  assistantId: string | null,
  version: string | null = RETRO_MIN_VERSION,
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
    // A real socket does not close synchronously: the state goes CLOSING and
    // the close event arrives once the handshake completes. That gap is where
    // a restart can race the runtime's session slot, so the fake keeps it
    // rather than collapsing it to zero and hiding what it is here to test.
    this.readyState = 2; // CLOSING
  }

  /** The close handshake completing, which is the event a real socket fires. */
  serverAcknowledgeClose(): void {
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
type Timeouts = { readyTimeoutMs?: number; drainTimeoutMs?: number };

const toggle = ({
  readyTimeoutMs = 50,
  drainTimeoutMs = 25,
}: Timeouts = {}): Promise<void> => {
  return toggleWatch({
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    captureFactory: capture.factory,
    // Stands in for the mint alone. The self-hosted branch still runs the real
    // resolver, so the cases about a missing actor token and a paired ingress
    // exercise the rules rather than this stub's idea of them.
    resolveWsUrl: async (assistantId: string) => {
      if (ingressUrl !== null) {
        return resolveWatchStreamWsUrl(assistantId);
      }
      mintCalls.push(assistantId);
      if (mintGate) {
        await mintGate;
      }
      if (mintedToken === null) {
        throw new realConnection.VelayWsTokenError(403, "mint refused");
      }
      return realConnection.buildVelayWsUrl({
        assistantId,
        routePath: "/v1/watch/stream",
        token: mintedToken,
        params: LIVE_VOICE_AUDIO_FORMAT_PARAMS,
      });
    },
    readyTimeoutMs,
    drainTimeoutMs,
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
const startPending = async (timeouts: Timeouts = {}) => {
  await toggle(timeouts);
  socket().serverOpen();
  await Promise.resolve();
};

/** Stop, and let the runtime answer, which is a session fully ended. */
const stopAndSettle = async (): Promise<void> => {
  stopWatch();
  socket().serverMessage({ type: "closed" });
  await Promise.resolve();
};

/** The runtime's terminal frame, which is what ends a drain after stop. */
const serverClosed = (): void => {
  socket().serverMessage({ type: "closed" });
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
const startRunning = async (timeouts: Timeouts = {}) => {
  await startPending(timeouts);
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

/**
 * A handoff bound for cases that assert a restart is still waiting.
 *
 * They sample a few milliseconds in, so the bound has to be far enough away
 * that a slow machine cannot let it expire first and turn "held back" into
 * "already started". Cases that only wait *for* the bound can use a small one:
 * overshooting that direction is harmless.
 */
const HELD = 200;

beforeEach(() => {
  ingressUrl = "http://localhost:8500";
  actorToken = "actor-jwt";
  applyConnection();
  pcmSupported = true;
  mintCalls = [];
  mintedToken = "velay-token";
  mintGate = null;
  sockets = [];
  capture = createCaptureFake();
  useLiveVoiceStore.setState({ state: "idle" });
  liveVoiceListeners = 0;
  // The watch store is module state shared by every case in this file, and the
  // session's own writes are the only thing that ever moves it. Cleared here so
  // a case reads its own session's counts rather than inheriting the previous
  // one's, which would make the reset a session does on `ready` look like test
  // isolation it is not providing.
  useWatchStore.setState({ watching: false, captureCount: 0 });
  activate(ASSISTANT_ID);
  // Module state like the session slot, and with a give-up timer behind it that
  // would otherwise outlive the case that armed it.
  clearWatchRetro();
});

afterEach(() => {
  // Whatever a case left running, so the module-level slot never leaks into
  // the next one. The close is what settles a session left draining: the
  // handoff a drain holds is module state too, and a case that inherited one
  // would wait out the whole drain before it could start anything.
  stopWatch();
  for (const ws of sockets) {
    ws.emit("close", { code: 1000 });
  }
  clearWatchRetro();
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
    await stopAndSettle();

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

  test("opens nothing without an actor token to authenticate with", async () => {
    actorToken = null;
    applyConnection();

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
 * The capture count, which is what the companion draws each time the user's
 * screen has actually been read.
 *
 * The runtime owns the cadence and reports only the reads that landed, so the
 * whole of this module's job is to count its `observation` frames and never to
 * invent one. Every case here is one way an extra count would be a lie.
 */
describe("counting the session's captures", () => {
  /** The runtime reporting one screen read that reached its timeline. */
  const serverObservation = async (): Promise<void> => {
    socket().serverMessage({ type: "observation" });
    await Promise.resolve();
  };

  const captures = (): number => useWatchStore.getState().captureCount;

  test("counts one capture per observation frame", async () => {
    await startRunning();
    expect(captures()).toBe(0);

    await serverObservation();
    expect(captures()).toBe(1);

    await serverObservation();
    expect(captures()).toBe(2);
  });

  /**
   * A session that inherited the last one's total would be indistinguishable
   * from one that had already captured something, which is the state the
   * surface draws a capture from.
   */
  test("starts each session's count from none", async () => {
    await startRunning();
    await serverObservation();
    await serverObservation();
    expect(captures()).toBe(2);

    await stopAndSettle();
    await startRunning();

    expect(captures()).toBe(0);
  });

  /**
   * The stop edge takes the flag down before the socket drains, so from that
   * moment nothing is drawing a capture. A late read arriving on the flush has
   * nothing left to mark, and counting it would step the number under a
   * session the user has already ended.
   */
  test("ignores an observation that lands after the user stopped", async () => {
    await startRunning();
    await serverObservation();
    expect(captures()).toBe(1);

    stopWatch();
    expect(useWatchStore.getState().watching).toBe(false);
    await serverObservation();

    expect(captures()).toBe(1);
  });

  /**
   * A session's own reads and nothing else. The frame is the only thing that
   * may move this number: no timer here approximates the runtime's cadence,
   * and audio going out is not evidence that anything came back.
   */
  test("counts nothing for narration the session merely sent", async () => {
    await startRunning();

    capture.pushChunk(new ArrayBuffer(8));
    socket().serverMessage({ type: "entry" });
    await wait(30);

    expect(captures()).toBe(0);
  });
});

/**
 * The managed transport, which is the one most users are on.
 *
 * A managed assistant has no ingress of its own to dial, so the session goes
 * through velay with a minted token instead — the same route, reached the
 * other way. The gateway admits only the guardian on either path, so what
 * these cases pin is that the press reaches a socket at all, and that a start
 * which cannot get a token leaves nothing behind.
 */
describe("a watch session on a managed assistant", () => {
  /**
   * Resolve once the mint has actually been entered, so a case that means to
   * interrupt it interrupts it rather than something earlier.
   */
  const whenMintInFlight = async (): Promise<void> => {
    // Real timer turns, not microtasks: a start can be held behind the
    // previous session's drain, which is a `setTimeout`, so a microtask-only
    // spin would give up before the mint was ever reached.
    for (let i = 0; i < 200 && mintCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (mintCalls.length === 0) {
      throw new Error("Expected the mint to have been entered");
    }
  };

  /** No self-hosted ingress is what makes an assistant managed here. */
  const managed = (): void => {
    ingressUrl = null;
    actorToken = null;
    applyConnection();
  };

  test("mints a velay token and dials velay with it", async () => {
    managed();

    await startRunning();

    expect(mintCalls).toEqual([ASSISTANT_ID]);
    const url = new URL(socket().url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    // The `/<assistantId>` prefix is what selects the tunnel; velay strips it
    // to recover the upstream path it matches its allowlist against.
    expect(url.pathname).toBe(`/${ASSISTANT_ID}/v1/watch/stream`);
    expect(url.searchParams.get("token")).toBe("velay-token");
    expect(url.searchParams.get("mimeType")).toBe("audio/pcm");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("opens nothing when the platform refuses the mint", async () => {
    managed();
    mintedToken = null;

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("leaves the slot free for a later press when the mint is refused", async () => {
    managed();
    mintedToken = null;
    await toggle();

    // A refused start that kept the slot would swallow the next press as a
    // stop, and the user would have to press twice to get anywhere.
    mintedToken = "velay-token";
    await startRunning();

    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("a stop pressed while the token is being minted opens nothing", async () => {
    managed();
    let releaseMint = (): void => {};
    mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });

    const starting = toggle();
    // The press lands while the mint is in flight, which is the window the
    // registered attempt exists to cover. Waited for rather than assumed: a
    // stop that arrived before the mint began would exercise the version-gate
    // cancellation instead and pass for the wrong reason.
    await whenMintInFlight();
    stopWatch();
    releaseMint();
    await starting;

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  test("a stop mid-mint does not wedge the next press", async () => {
    managed();
    let releaseMint = (): void => {};
    mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    const starting = toggle();
    await whenMintInFlight();
    stopWatch();
    releaseMint();
    await starting;

    mintGate = null;
    await startRunning();

    expect(useWatchStore.getState().watching).toBe(true);
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
 * Which edge a press is, answered before the press.
 *
 * `toggleWatch` decides that from its slot, and `handleToggleWatchCommand`
 * (`src/runtime/watch-command.ts`) has to know the same answer one step
 * earlier: it gates the start edge on the Watch flag and must let the stop edge
 * through regardless, so a flag turned off mid-session cannot strand a capture
 * with nothing that ends it.
 */
describe("whether a session is running, from outside the toggle", () => {
  test("is false with nothing running", () => {
    expect(isWatchSessionActive()).toBe(false);
  });

  /**
   * The reason this is not `useWatchStore`.
   *
   * A start is registered in the slot before it resolves its version gate, so
   * it is already stoppable while the store still says no. A caller reading the
   * store would call that press a start, and gate it.
   */
  test("is true for an attempt the flag has not caught up to", async () => {
    activate(ASSISTANT_ID, null);
    const pressed = toggle();

    expect(isWatchSessionActive()).toBe(true);
    expect(useWatchStore.getState().watching).toBe(false);

    stopWatch();
    activate(ASSISTANT_ID);
    await pressed;
  });

  test("is true while a session is running", async () => {
    await startRunning();

    expect(isWatchSessionActive()).toBe(true);
  });

  test("is false once the session has ended", async () => {
    await startRunning();
    await stopAndSettle();

    expect(isWatchSessionActive()).toBe(false);
  });
});

/**
 * The window after stop, where the runtime is still flushing.
 *
 * `{"type":"stop"}` does not end a session on the daemon: it moves it to
 * `stopping` and asks the transcriber to flush, and late `final` events reach
 * the timeline for as long as that holds. Closing the socket on the spot runs
 * the daemon's close handler instead and takes the flush with it, which costs
 * a long session its last phrase and can cost a short one everything.
 */
describe("the flush window after the user stops", () => {
  test("asks the runtime to wrap up and leaves the socket open for it", async () => {
    await startRunning();

    stopWatch();

    expect(socket().sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    expect(socket().closeCalls).toEqual([]);
    expect(socket().readyState).toBe(1);
  });

  /**
   * The point of the whole thing. A `final` the provider emits after stop has
   * to still have a socket to arrive on, and this asserts the socket was open
   * at the moment it landed rather than merely that nothing threw.
   */
  test("a final arriving after stop still reaches the runtime", async () => {
    await startRunning();

    stopWatch();
    // Everything that has to be true at the instant a late final lands: the
    // stop frame went out, so the runtime is flushing rather than idle; the
    // socket is still open, so there is somewhere for the final to arrive; and
    // nothing has closed it, so the runtime's close handler has not run and
    // taken the flush with it. A test that only checked "nothing threw" would
    // pass just as well if the stop frame were never sent at all.
    const atTheMoment = {
      askedToFlush: socket().sent.includes(JSON.stringify({ type: "stop" })),
      socketOpen: socket().readyState === 1,
      closesSoFar: socket().closeCalls.length,
    };
    socket().serverMessage({ type: "entry" });
    serverClosed();

    expect(atTheMoment).toEqual({
      askedToFlush: true,
      socketOpen: true,
      closesSoFar: 0,
    });
    expect(socket().closeCalls).toEqual([1000]);
  });

  test("closes once the runtime says the session is closed", async () => {
    await startRunning();

    stopWatch();
    expect(socket().closeCalls).toEqual([]);
    serverClosed();

    expect(socket().closeCalls).toEqual([1000]);
  });

  /** Losing the tail beats a session that will not end. */
  test("gives up on a runtime that never answers", async () => {
    await startRunning({ drainTimeoutMs: 5 });

    stopWatch();
    expect(socket().closeCalls).toEqual([]);
    await wait(30);

    expect(socket().closeCalls).toEqual([1000]);
  });

  test("stops waiting once the runtime has answered", async () => {
    await startRunning({ drainTimeoutMs: 5 });

    stopWatch();
    serverClosed();
    await wait(30);

    expect(socket().closeCalls).toEqual([1000]);
  });

  /**
   * Everything the user perceives ends on the press, whatever the socket is
   * still doing. `stopWatch` runs inside one synchronous stretch on the
   * hard-logout path, which navigates away immediately afterwards.
   */
  test("ends the session for the user before the socket has closed", async () => {
    await startRunning();

    stopWatch();
    // The summary the stop leaves behind holds its own subscription on the
    // active-assistant store, which is not the session's to release.
    clearWatchRetro();

    expect(useWatchStore.getState().watching).toBe(false);
    expect(capture.calls.shutdown).toBe(1);
    expect(liveVoiceListeners).toBe(0);
    expect(assistantListeners.size).toBe(0);
    expect(socket().closeCalls).toEqual([]);
  });

  test("publishes the flag going down in the same tick as the press", async () => {
    await startRunning();

    const seen: boolean[] = [];
    const unsubscribe = useWatchStore.subscribe((state) => {
      seen.push(state.watching);
    });
    stopWatch();
    unsubscribe();

    expect(seen).toEqual([false]);
  });

  /**
   * A restart pressed inside the drain window.
   *
   * The runtime holds one session slot until the old provider says `closed`,
   * so a second socket opened before that is refused as busy and the user gets
   * nothing. The press waits for the handoff instead and then starts, which is
   * the difference between a restart that is slow and one that silently fails.
   */
  test("starts a session pressed during the drain, once the drain ends", async () => {
    await startRunning({ drainTimeoutMs: HELD });
    stopWatch();

    const pressed = toggle();
    // Long enough for the version gate to settle and the start to have opened
    // a socket if nothing were holding it back. Asserting synchronously here
    // would pass either way, since the gate resolves on a microtask.
    await wait(5);
    const openedBeforeTheHandoff = sockets.length;

    serverClosed();
    await pressed;
    socket().serverOpen();
    await serverReady();

    // Waited for the handoff, then started: one socket while the runtime still
    // held its slot, two once it let go.
    expect(openedBeforeTheHandoff).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /** The wait is bounded by the drain's own timer, not by the runtime. */
  test("starts a session pressed during a drain the runtime never ends", async () => {
    await startRunning({ drainTimeoutMs: HELD });
    stopWatch();

    const pressed = toggle();
    await wait(5);
    const openedBeforeTheTimeout = sockets.length;

    // The press resolves when the bound releases the handoff, so awaiting it
    // is the wait. Sleeping past that point would burn the new session's own
    // ready timer before this test could answer it.
    await pressed;
    socket().serverOpen();
    await serverReady();

    expect(openedBeforeTheTimeout).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("starts normally once the drain is already over", async () => {
    await startRunning();
    await stopAndSettle();

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /** A press waiting on the handoff is still the user's to take back. */
  test("stays cancellable while it waits for the handoff", async () => {
    await startRunning({ drainTimeoutMs: HELD });
    stopWatch();

    const pressed = toggle();
    await wait(5);
    stopWatch();
    serverClosed();
    await pressed;

    expect(sockets).toHaveLength(1);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * Only a deliberate stop owes the runtime a flush. Every other ending is
   * already over, so waiting would hold a socket open for nothing.
   */
  test("does not wait when a call takes the microphone", async () => {
    await startRunning();

    useLiveVoiceStore.setState({ state: "listening" });

    expect(socket().closeCalls).toEqual([1000]);
  });

  test("does not wait when the assistant changes", async () => {
    await startRunning();

    activate("asst-other");

    expect(socket().closeCalls).toEqual([1000]);
  });

  test("does not wait when the runtime reports an error", async () => {
    await startRunning();

    socket().serverMessage({ type: "error", message: "provider gone" });

    expect(socket().closeCalls).toEqual([1000]);
  });

  /**
   * A session the runtime never accepted has captured nothing and holds
   * nothing, so it owes no flush. The runtime's `handleStop` ignores the stop
   * frame outright while it is still `initializing`, so draining would hold
   * the socket open until the timer gave up and leave the runtime session
   * alive for that whole window.
   */
  test("closes at once when the runtime never accepted the session", async () => {
    await startPending();

    stopWatch();

    expect(socket().closeCalls).toEqual([1000]);
    expect(socket().sent).toEqual([]);
  });

  test("still drains a session the runtime did accept", async () => {
    await startRunning();

    stopWatch();

    expect(socket().closeCalls).toEqual([]);
    expect(socket().sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
  });

  /**
   * The narrow window between the runtime claiming its session slot and
   * announcing it.
   *
   * `WatchStreamSession.start()` calls `manager.start()` before it sends
   * `ready`, so a session stopped in between has a runtime session behind it
   * even though nothing here ever saw one. Releasing the restart claim on
   * `ready` alone let the next press open a socket the runtime refused as
   * busy, which is the same silent failure as the wider case next door.
   */
  test("holds a restart until a session the runtime never announced is released", async () => {
    await startPending({ drainTimeoutMs: HELD });
    stopWatch();

    const pressed = toggle();
    // Settled, not sampled: the version gate resolves on a microtask, so a
    // synchronous read here would be 1 whether or not anything is waiting.
    await wait(5);
    const openedBeforeTheHandoff = sockets.length;

    // **The downstream close is not evidence.** The gateway's close handler
    // calls `upstream.close()` and returns without waiting for the upstream
    // handshake or the runtime's `handleClose`, so this socket reporting
    // closed says nothing about whether the runtime has let its slot go. The
    // claim has to outlive it.
    socket().serverAcknowledgeClose();
    await wait(5);
    const openedAfterTheSocketClosed = sockets.length;

    // Which leaves the bound as the only signal, since a session closed
    // before `ready` sends no stop frame and so gets no `closed` frame back.
    await pressed;
    socket().serverOpen();
    await serverReady();

    expect(openedBeforeTheHandoff).toBe(1);
    expect(openedAfterTheSocketClosed).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /**
   * The cost of holding to honest signals: a restart pressed straight after a
   * pending stop waits out the bound. Deliberate, and cheaper than a restart
   * the runtime refuses.
   */
  test("starts once the bound expires, with no runtime answer coming", async () => {
    await startPending({ drainTimeoutMs: 20 });
    stopWatch();

    const pressed = toggle();
    await pressed;
    socket().serverOpen();
    await serverReady();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  /** The socket still closes at once; only the restart claim is held. */
  test("closes a pending session's socket without waiting to release it", async () => {
    await startPending();

    stopWatch();

    expect(socket().closeCalls).toEqual([1000]);
    expect(socket().sent).toEqual([]);
  });

  /** Nothing to flush and nothing to wait for on a socket that is not open. */
  test("does not wait when the socket is already gone", async () => {
    await startRunning();
    socket().readyState = 3;

    stopWatch();

    expect(useWatchStore.getState().watching).toBe(false);
    expect(capture.calls.shutdown).toBe(1);
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
describe("the summary a stopped session leaves behind", () => {
  /**
   * A stopped session is not a finished one: the runtime writes an account of
   * what was narrated in a turn that starts after this socket is gone, and the
   * surface has to say so from the press onward rather than from whenever the
   * flush lands.
   */
  test("the wait starts on the stop press, named by the runtime's own ids", async () => {
    await startRunning();

    stopWatch();

    expect(useWatchRetroStore.getState().retro).toEqual({
      sessionId: "sess-1",
      conversationId: "conv-1",
      assistantId: ASSISTANT_ID,
      phase: "pending",
    });
  });

  // A start the runtime never accepted recorded nothing, so there is no
  // retrospective coming and nothing to tell the user about.
  test("a session the runtime never accepted leaves nothing to wait on", async () => {
    await startPending();

    stopWatch();

    expect(useWatchRetroStore.getState().retro).toBeNull();
  });

  /**
   * Every ending that is not the user's own press is something going wrong: a
   * socket that dropped, a call taking the microphone, the layout going away.
   * None of them is a request for a summary, and a runtime that is gone is not
   * going to write one.
   */
  test("a socket that drops leaves nothing to wait on", async () => {
    await startRunning();

    socket().emit("close", { code: 1006 });
    await Promise.resolve();

    expect(useWatchRetroStore.getState().retro).toBeNull();
  });
});

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
      await startPending({ readyTimeoutMs: 5 });
      await wait(30);
    });

    expect(seen).toEqual([]);
    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
  });

  test("frees the slot on giving up, so the next press opens a new session", async () => {
    await startPending({ readyTimeoutMs: 5 });
    await wait(30);

    await startRunning();

    expect(sockets).toHaveLength(2);
    expect(useWatchStore.getState().watching).toBe(true);
  });

  test("does not give up on a session the runtime did answer for", async () => {
    await startRunning({ readyTimeoutMs: 5 });

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
 * A call takes the microphone from a watch session.
 *
 * The refusal in `toggleWatch` only covers Watch pressed during a call. Live
 * voice has its own doors, and they do not consult this module, so the session
 * has to give the microphone up rather than every one of those doors having to
 * learn to refuse.
 */
describe("a watch session when a call starts", () => {
  const startCall = () => {
    useLiveVoiceStore.setState({ state: "listening" });
  };

  test("ends a running session", async () => {
    await startRunning();

    startCall();

    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * A session still waiting on `ready` has a socket the call knows nothing
   * about, and a microphone about to open the moment the runtime answers.
   */
  test("ends a session still pending, before it can open the microphone", async () => {
    const seen = await flagEmissions(async () => {
      await startPending();
      startCall();
      await serverReady();
    });

    expect(capture.calls.started).toBe(0);
    expect(capture.calls.shutdown).toBe(1);
    expect(seen).toEqual([]);
  });

  test("leaves one owner of the microphone", async () => {
    await startRunning();
    expect(capture.calls.started).toBe(1);

    startCall();

    expect(capture.calls.shutdown).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  /**
   * The other direction, which was already guarded and has to stay guarded:
   * pressing Watch during a call opens nothing.
   */
  test("still refuses a press that lands during a call", async () => {
    startCall();

    await toggle();

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * A call starting while the version gate resolves. Guarded by the re-read
   * after the await rather than by the subscription, since there is no session
   * yet to subscribe on its behalf.
   */
  test("cancels a start that is still resolving the version gate", async () => {
    activate(ASSISTANT_ID, null);
    const pressed = toggle();

    startCall();
    activate(ASSISTANT_ID);
    await pressed;

    expect(sockets).toHaveLength(0);
    expect(useWatchStore.getState().watching).toBe(false);
  });

  /**
   * The subscription lives exactly as long as the session does. Left behind it
   * fires harmlessly, because teardown is idempotent, and accumulates one
   * listener per session for the life of the page.
   */
  test("stops listening for calls once the session is over", async () => {
    await startRunning();
    expect(liveVoiceListeners).toBe(1);

    stopWatch();

    expect(liveVoiceListeners).toBe(0);
  });

  test("leaves nothing behind across repeated sessions", async () => {
    await startRunning();
    await stopAndSettle();
    await startRunning();
    await stopAndSettle();

    expect(liveVoiceListeners).toBe(0);
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
    // The summary the stop leaves behind binds to this same store on the same
    // terms, and outlives the session on purpose. Released here so what is
    // counted is the session's subscription and nothing else.
    clearWatchRetro();

    expect(assistantListeners.size).toBe(0);
  });

  test("leaves nothing behind across repeated sessions", async () => {
    await startRunning();
    await stopAndSettle();
    await startRunning();
    await stopAndSettle();
    clearWatchRetro();

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
  test("releases the microphone and the flag, then closes the socket", async () => {
    await startRunning();

    stopWatch();
    serverClosed();

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
    serverClosed();

    expect(capture.calls.shutdown).toBe(1);
    expect(socket().closeCalls).toEqual([1000]);
    expect(socket().sent).toEqual([JSON.stringify({ type: "stop" })]);
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
