/**
 * Unit tests for `LiveVoicePcmCapture` — verifies the lifecycle and
 * message routing without spinning up a real `AudioContext` or
 * microphone.
 *
 * Covers:
 *  (a) `start()` returns `false` when `getUserMedia` rejects
 *  (b) `start()` returns `true` and forwards chunks/amplitude from the
 *      mock worklet to the supplied callbacks
 *  (c) `stop()` is idempotent
 *  (d) `shutdown()` releases MediaStream tracks and closes the
 *      AudioContext, and is idempotent
 *  (e) `stop()` issued before `getUserMedia` resolves cancels the
 *      pending start and releases the late-arriving stream
 *  (f) Two overlapping `start()` calls cooperate — only the latest
 *      wins; the earlier one releases its stream
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { LiveVoicePcmCapture } from "../pcm-capture";

// ---------------------------------------------------------------------------
// Mock primitives
// ---------------------------------------------------------------------------

class MockMediaStreamTrack {
  kind = "audio";
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
}

class MockMediaStream {
  private tracks: MockMediaStreamTrack[];
  constructor() {
    this.tracks = [new MockMediaStreamTrack()];
  }
  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }
}

class MockMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  /** Test helper: simulate the worklet posting to the main thread. */
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class MockAudioWorkletNode {
  port = new MockMessagePort();
  disconnectCount = 0;
  connectedTo: unknown[] = [];
  constructor(public context: MockAudioContext, public name: string) {
    context.lastWorkletNode = this;
  }
  connect(destination: unknown): void {
    this.connectedTo.push(destination);
  }
  disconnect() {
    this.disconnectCount += 1;
  }
}

class MockMediaStreamAudioSourceNode {
  disconnectCount = 0;
  connectedTo: unknown[] = [];
  constructor(public context: MockAudioContext, public stream: MockMediaStream) {}
  connect(destination: unknown): void {
    this.connectedTo.push(destination);
  }
  disconnect() {
    this.disconnectCount += 1;
  }
}

class MockAudioWorklet {
  loadedModules: string[] = [];
  addModule(url: string): Promise<void> {
    this.loadedModules.push(url);
    return Promise.resolve();
  }
}

class MockAudioDestinationNode {}

class MockGainNode {
  gain = { value: 1 };
  disconnectCount = 0;
  connectedTo: unknown[] = [];
  constructor(public context: MockAudioContext) {}
  connect(destination: unknown): void {
    this.connectedTo.push(destination);
  }
  disconnect() {
    this.disconnectCount += 1;
  }
}

class MockAudioContext {
  /**
   * Initial `state` for the next-constructed `MockAudioContext`. The
   * capture instantiates its context internally, so tests use this
   * static hook to drive the suspended-context branch without reaching
   * into private state.
   */
  static nextInitialState: "suspended" | "running" | "closed" | null = null;
  /**
   * Override `resume()` impl for the next-constructed context. Lets
   * tests simulate a resume rejection without prototype patching.
   */
  static nextResumeImpl: (() => Promise<void>) | null = null;
  static lastInstance: MockAudioContext | null = null;
  audioWorklet = new MockAudioWorklet();
  destination = new MockAudioDestinationNode();
  closed = false;
  /**
   * Mirrors the real `AudioContext.state` so the capture's
   * suspended-context branch can be exercised. Defaults to `"running"`;
   * tests that need to drive the suspended path set
   * `MockAudioContext.nextInitialState = "suspended"` before invoking
   * `start()` and supply a `resumeImpl` via `MockAudioContext.lastInstance`.
   */
  state: "suspended" | "running" | "closed" = "running";

  constructor() {
    if (MockAudioContext.nextInitialState !== null) {
      this.state = MockAudioContext.nextInitialState;
      MockAudioContext.nextInitialState = null;
    }
    if (MockAudioContext.nextResumeImpl !== null) {
      this.resumeImpl = MockAudioContext.nextResumeImpl;
      MockAudioContext.nextResumeImpl = null;
    }
    MockAudioContext.lastInstance = this;
  }
  /**
   * Number of times `resume()` has been called. Tests assert this
   * to verify the suspended-context branch ran.
   */
  resumeCalls = 0;
  /**
   * Override hook for `resume()` — by default it flips `state` to
   * `"running"` and resolves. Tests that need to simulate a rejection
   * (e.g. user-gesture missing) overwrite this with a rejecting impl.
   */
  resumeImpl: () => Promise<void> = () => {
    this.state = "running";
    return Promise.resolve();
  };
  lastWorkletNode: MockAudioWorkletNode | null = null;
  lastSourceNode: MockMediaStreamAudioSourceNode | null = null;
  lastGainNode: MockGainNode | null = null;
  createMediaStreamSource(stream: MockMediaStream): MockMediaStreamAudioSourceNode {
    const node = new MockMediaStreamAudioSourceNode(this, stream);
    this.lastSourceNode = node;
    return node;
  }
  createGain(): MockGainNode {
    const node = new MockGainNode(this);
    this.lastGainNode = node;
    return node;
  }
  resume(): Promise<void> {
    this.resumeCalls += 1;
    return this.resumeImpl();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Global wiring
// ---------------------------------------------------------------------------

interface TestGlobals {
  AudioContext: typeof MockAudioContext;
  AudioWorkletNode: typeof MockAudioWorkletNode;
  navigator: {
    mediaDevices: {
      getUserMedia: (constraints: unknown) => Promise<MockMediaStream>;
    };
  };
}

const originals = {
  AudioContext: (globalThis as unknown as { AudioContext?: unknown })
    .AudioContext,
  AudioWorkletNode: (globalThis as unknown as { AudioWorkletNode?: unknown })
    .AudioWorkletNode,
  mediaDevices: (
    globalThis as unknown as { navigator?: { mediaDevices?: unknown } }
  ).navigator?.mediaDevices,
};

let mockStream: MockMediaStream | null = null;
let getUserMediaImpl: (constraints: unknown) => Promise<MockMediaStream> = () =>
  Promise.reject(new Error("getUserMedia not configured"));

function installMocks() {
  const g = globalThis as unknown as TestGlobals;
  g.AudioContext = MockAudioContext;
  g.AudioWorkletNode = MockAudioWorkletNode;

  // Bun's happy-dom registrator sets `navigator`, so we patch
  // `mediaDevices` rather than replacing the whole navigator object.
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (constraints: unknown) => getUserMediaImpl(constraints),
    },
  });
}

function restoreMocks() {
  const g = globalThis as unknown as Record<string, unknown>;
  if (originals.AudioContext === undefined) {
    delete g.AudioContext;
  } else {
    g.AudioContext = originals.AudioContext;
  }
  if (originals.AudioWorkletNode === undefined) {
    delete g.AudioWorkletNode;
  } else {
    g.AudioWorkletNode = originals.AudioWorkletNode;
  }
  if (originals.mediaDevices === undefined) {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
  } else {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: originals.mediaDevices,
    });
  }
}

beforeEach(() => {
  mockStream = null;
  getUserMediaImpl = () =>
    Promise.reject(new Error("getUserMedia not configured"));
  MockAudioContext.nextInitialState = null;
  MockAudioContext.nextResumeImpl = null;
  MockAudioContext.lastInstance = null;
  installMocks();
});

afterEach(() => {
  restoreMocks();
});

/**
 * Test-only escape hatch for reading the capture's internal AudioContext.
 * Keeps the public API surface clean while still letting tests drive the
 * worklet port directly.
 */
function getInternalContext(capture: LiveVoicePcmCapture): MockAudioContext {
  const ctx = (capture as unknown as { audioContext: MockAudioContext })
    .audioContext;
  expect(ctx).toBeInstanceOf(MockAudioContext);
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiveVoicePcmCapture", () => {
  it("returns false when getUserMedia rejects", async () => {
    getUserMediaImpl = () => Promise.reject(new Error("denied"));

    const capture = new LiveVoicePcmCapture();
    const ok = await capture.start({ onChunk: () => undefined });

    expect(ok).toBe(false);
  });

  it("returns true and forwards chunks/amplitude when worklet posts", async () => {
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);

    const chunks: { pcm16: Int16Array; frameCount: number; amplitude: number }[] = [];
    const amplitudes: number[] = [];

    const capture = new LiveVoicePcmCapture();
    const ok = await capture.start({
      onChunk: (chunk) => chunks.push(chunk),
      onAmplitude: (a) => amplitudes.push(a),
    });
    expect(ok).toBe(true);

    // The most recently constructed worklet node lives on the
    // AudioContext the capture is using. Reach in and simulate the
    // audio-thread posting messages.
    const lastContext = getInternalContext(capture);
    const lastWorklet = lastContext.lastWorkletNode;
    expect(lastWorklet).not.toBeNull();

    const pcm = new Int16Array([1, 2, 3]);
    lastWorklet!.port.emit({
      type: "chunk",
      pcm16: pcm,
      frameCount: 3,
      amplitude: 0.42,
    });
    lastWorklet!.port.emit({ type: "amplitude", amplitude: 0.75 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.frameCount).toBe(3);
    expect(chunks[0]!.amplitude).toBe(0.42);
    expect(Array.from(chunks[0]!.pcm16)).toEqual([1, 2, 3]);
    expect(amplitudes).toEqual([0.75]);

    // Verify worklet module was registered at the expected static path.
    expect(lastContext.audioWorklet.loadedModules).toEqual([
      "/worklets/pcm16k-capture-processor.js",
    ]);
  });

  it("connects the worklet through a muted GainNode to the destination", async () => {
    // Regression: Web Audio only pulls render quanta along edges that
    // terminate at `audioContext.destination`. Without the muted sink
    // the AudioWorklet's `process()` never runs and live voice gets
    // zero PCM chunks.
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);

    const capture = new LiveVoicePcmCapture();
    const ok = await capture.start({ onChunk: () => undefined });
    expect(ok).toBe(true);

    const lastContext = getInternalContext(capture);
    const worklet = lastContext.lastWorkletNode!;
    const gain = lastContext.lastGainNode!;
    expect(gain).not.toBeNull();

    // Worklet feeds into the GainNode, which feeds into destination.
    expect(worklet.connectedTo).toContain(gain);
    expect(gain.gain.value).toBe(0);
    expect(gain.connectedTo).toContain(lastContext.destination);
  });

  it("stop() is idempotent", async () => {
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);

    const capture = new LiveVoicePcmCapture();
    await capture.start({ onChunk: () => undefined });
    const lastContext = getInternalContext(capture);
    const worklet = lastContext.lastWorkletNode!;
    const source = lastContext.lastSourceNode!;
    const gain = lastContext.lastGainNode!;

    capture.stop();
    expect(worklet.disconnectCount).toBe(1);
    expect(source.disconnectCount).toBe(1);
    expect(gain.disconnectCount).toBe(1);
    expect(mockStream!.getTracks()[0]!.readyState).toBe("ended");

    // Second stop is a no-op and does not throw.
    expect(() => capture.stop()).not.toThrow();
    expect(worklet.disconnectCount).toBe(1);
    expect(source.disconnectCount).toBe(1);
    expect(gain.disconnectCount).toBe(1);

    // AudioContext stays warm after stop().
    expect(lastContext.closed).toBe(false);
  });

  it("start() called while already active releases the previous MediaStream", async () => {
    // Regression: previously `start()` only called `stopInternal()` when
    // restarting, leaving the old MediaStream alive and leaking the mic.
    const streams: MockMediaStream[] = [];
    getUserMediaImpl = () => {
      const s = new MockMediaStream();
      streams.push(s);
      return Promise.resolve(s);
    };

    const capture = new LiveVoicePcmCapture();
    const ok1 = await capture.start({ onChunk: () => undefined });
    expect(ok1).toBe(true);
    const ok2 = await capture.start({ onChunk: () => undefined });
    expect(ok2).toBe(true);

    // Two distinct streams were opened; the first one must have been
    // released so the OS-level mic indicator can clear.
    expect(streams).toHaveLength(2);
    expect(streams[0]!.getTracks()[0]!.readyState).toBe("ended");
    expect(streams[1]!.getTracks()[0]!.readyState).toBe("live");
  });

  it("shutdown() releases MediaStream tracks, closes AudioContext, and is idempotent", async () => {
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);

    const capture = new LiveVoicePcmCapture();
    await capture.start({ onChunk: () => undefined });
    const lastContext = getInternalContext(capture);
    const gain = lastContext.lastGainNode!;

    capture.shutdown();
    expect(mockStream!.getTracks()[0]!.readyState).toBe("ended");
    expect(lastContext.closed).toBe(true);
    expect(gain.disconnectCount).toBe(1);

    // Second shutdown is a no-op.
    expect(() => capture.shutdown()).not.toThrow();
    expect(lastContext.closed).toBe(true);
    expect(gain.disconnectCount).toBe(1);

    // start() after shutdown returns false.
    const ok = await capture.start({ onChunk: () => undefined });
    expect(ok).toBe(false);
  });

  it("stop() during a pending start() cancels it and releases the late stream", async () => {
    // Regression: in a push-to-talk flow, the user can release the key
    // before `getUserMedia()` resolves. The pending start must observe
    // the cancellation, release the stream that does eventually arrive,
    // and return false rather than wiring up a phantom mic.
    let resolveGetUserMedia: ((stream: MockMediaStream) => void) | null = null;
    const pendingStream = new MockMediaStream();
    getUserMediaImpl = () =>
      new Promise<MockMediaStream>((resolve) => {
        resolveGetUserMedia = resolve;
      });

    const capture = new LiveVoicePcmCapture();
    const startPromise = capture.start({ onChunk: () => undefined });

    // User releases PTT key before `getUserMedia` resolves.
    capture.stop();

    // Now permission grant resolves, late — pending start should
    // release the stream and bail.
    expect(resolveGetUserMedia).not.toBeNull();
    resolveGetUserMedia!(pendingStream);

    const ok = await startPromise;
    expect(ok).toBe(false);
    expect(pendingStream.getTracks()[0]!.readyState).toBe("ended");

    // No nodes should have been wired up.
    const internalStream = (
      capture as unknown as { stream: MockMediaStream | null }
    ).stream;
    const internalWorklet = (
      capture as unknown as { workletNode: MockAudioWorkletNode | null }
    ).workletNode;
    expect(internalStream).toBeNull();
    expect(internalWorklet).toBeNull();
  });

  it("two overlapping start() calls cancel the earlier one and only the latest wins", async () => {
    // Regression: prior to the generation counter, both starts would
    // race past the synchronous guard and the slower one would
    // overwrite the stored nodes, leaving the earlier capture's
    // MediaStream dangling.
    const resolvers: ((stream: MockMediaStream) => void)[] = [];
    const streams: MockMediaStream[] = [];
    getUserMediaImpl = () => {
      const stream = new MockMediaStream();
      streams.push(stream);
      return new Promise<MockMediaStream>((resolve) => {
        resolvers.push(resolve);
      });
    };

    const capture = new LiveVoicePcmCapture();
    const startPromise1 = capture.start({ onChunk: () => undefined });
    const startPromise2 = capture.start({ onChunk: () => undefined });

    // Both starts are pending on getUserMedia; the second one bumped
    // the generation past the first.
    expect(resolvers).toHaveLength(2);
    expect(streams).toHaveLength(2);

    // Resolve the FIRST start last to exercise the "earlier resolves
    // last" ordering too. Actually we want the first to resolve first
    // to mirror the bug scenario where the slower second overwrites
    // the first's nodes. With the generation counter both orderings
    // are correct — the first call always loses regardless of order.
    resolvers[0]!(streams[0]!);
    resolvers[1]!(streams[1]!);

    const [ok1, ok2] = await Promise.all([startPromise1, startPromise2]);

    expect(ok1).toBe(false);
    expect(ok2).toBe(true);

    // The first call's stream must be released; the second's must be
    // live and wired up.
    expect(streams[0]!.getTracks()[0]!.readyState).toBe("ended");
    expect(streams[1]!.getTracks()[0]!.readyState).toBe("live");

    const internalStream = (
      capture as unknown as { stream: MockMediaStream | null }
    ).stream;
    expect(internalStream).toBe(streams[1]!);
  });

  it("resumes a suspended AudioContext before reporting capture started", async () => {
    // Regression: Chrome's autoplay policy and mobile Safari's tab
    // lifecycle can leave the AudioContext in `"suspended"` immediately
    // after construction. Without an explicit `resume()`, the worklet's
    // `process()` never runs and live voice gets zero PCM chunks while
    // the UI silently reports "Listening…".
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);
    MockAudioContext.nextInitialState = "suspended";

    const capture = new LiveVoicePcmCapture();
    const ok = await capture.start({ onChunk: () => undefined });

    expect(ok).toBe(true);
    const ctx = getInternalContext(capture);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe("running");
  });

  it("returns false when resuming a suspended AudioContext rejects", async () => {
    // Regression companion to the suspended-resume test: if the browser
    // refuses to resume (e.g. no preceding user gesture on Safari),
    // returning `true` would leave the manager reporting "Listening…"
    // with no audio flowing. Treat the rejection as a start failure so
    // the manager can transition the UI to `failed` and offer retry.
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);
    MockAudioContext.nextInitialState = "suspended";
    MockAudioContext.nextResumeImpl = () =>
      Promise.reject(new Error("blocked"));

    const capture = new LiveVoicePcmCapture();
    const ok = await capture.start({ onChunk: () => undefined });

    expect(ok).toBe(false);
    const ctx = MockAudioContext.lastInstance;
    expect(ctx).not.toBeNull();
    expect(ctx!.resumeCalls).toBe(1);
    // Stream must be released on the failure path.
    expect(mockStream!.getTracks()[0]!.readyState).toBe("ended");
  });

  it("two overlapping start() calls — earlier resolves last, latest still wins", async () => {
    // Same as above but with the resolution order swapped: the second
    // (winning) start resolves first, then the stale first one
    // resolves. The first must still release its stream and not
    // clobber the second's nodes.
    const resolvers: ((stream: MockMediaStream) => void)[] = [];
    const streams: MockMediaStream[] = [];
    getUserMediaImpl = () => {
      const stream = new MockMediaStream();
      streams.push(stream);
      return new Promise<MockMediaStream>((resolve) => {
        resolvers.push(resolve);
      });
    };

    const capture = new LiveVoicePcmCapture();
    const startPromise1 = capture.start({ onChunk: () => undefined });
    const startPromise2 = capture.start({ onChunk: () => undefined });

    expect(resolvers).toHaveLength(2);

    resolvers[1]!(streams[1]!);
    resolvers[0]!(streams[0]!);

    const [ok1, ok2] = await Promise.all([startPromise1, startPromise2]);
    expect(ok1).toBe(false);
    expect(ok2).toBe(true);
    expect(streams[0]!.getTracks()[0]!.readyState).toBe("ended");
    expect(streams[1]!.getTracks()[0]!.readyState).toBe("live");

    const internalStream = (
      capture as unknown as { stream: MockMediaStream | null }
    ).stream;
    expect(internalStream).toBe(streams[1]!);
  });
});
