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
  constructor(public context: MockAudioContext, public name: string) {
    context.lastWorkletNode = this;
  }
  disconnect() {
    this.disconnectCount += 1;
  }
}

class MockMediaStreamAudioSourceNode {
  disconnectCount = 0;
  constructor(public context: MockAudioContext, public stream: MockMediaStream) {}
  connect(_destination: unknown): void {}
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

class MockAudioContext {
  audioWorklet = new MockAudioWorklet();
  closed = false;
  lastWorkletNode: MockAudioWorkletNode | null = null;
  lastSourceNode: MockMediaStreamAudioSourceNode | null = null;
  createMediaStreamSource(stream: MockMediaStream): MockMediaStreamAudioSourceNode {
    const node = new MockMediaStreamAudioSourceNode(this, stream);
    this.lastSourceNode = node;
    return node;
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

  it("stop() is idempotent", async () => {
    mockStream = new MockMediaStream();
    getUserMediaImpl = () => Promise.resolve(mockStream as MockMediaStream);

    const capture = new LiveVoicePcmCapture();
    await capture.start({ onChunk: () => undefined });
    const lastContext = getInternalContext(capture);
    const worklet = lastContext.lastWorkletNode!;
    const source = lastContext.lastSourceNode!;

    capture.stop();
    expect(worklet.disconnectCount).toBe(1);
    expect(source.disconnectCount).toBe(1);
    expect(mockStream!.getTracks()[0]!.readyState).toBe("ended");

    // Second stop is a no-op and does not throw.
    expect(() => capture.stop()).not.toThrow();
    expect(worklet.disconnectCount).toBe(1);
    expect(source.disconnectCount).toBe(1);

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

    capture.shutdown();
    expect(mockStream!.getTracks()[0]!.readyState).toBe("ended");
    expect(lastContext.closed).toBe(true);

    // Second shutdown is a no-op.
    expect(() => capture.shutdown()).not.toThrow();
    expect(lastContext.closed).toBe(true);

    // start() after shutdown returns false.
    const ok = await capture.start({ onChunk: () => undefined });
    expect(ok).toBe(false);
  });
});
