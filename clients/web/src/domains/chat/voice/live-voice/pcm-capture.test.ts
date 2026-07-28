import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The native audio-session bridge (`.playAndRecord` / `.voiceChat` on iOS) is a
// no-op off Capacitor, so it would be invisible here. Mock it to record the
// call order relative to getUserMedia — the ordering is the whole point: the
// category/mode must be in force *before* WebKit builds its capture unit.
// Declared before the module under test is imported.
const audioSessionCalls: string[] = [];
// Lets a test park one `activate` call mid-flight, standing in for a slow
// Capacitor bridge round-trip.
let activateCallCount = 0;
let gatedActivateCall: number | null = null;
let gate: { promise: Promise<void>; resolve: () => void } | null = null;

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

mock.module("@/runtime/native-voice-audio-session", () => ({
  activateVoiceAudioSession: mock(async () => {
    activateCallCount += 1;
    audioSessionCalls.push("activate");
    if (gate && gatedActivateCall === activateCallCount) await gate.promise;
  }),
  deactivateVoiceAudioSession: mock(async () => {
    audioSessionCalls.push("deactivate");
  }),
}));

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

const { isSupported, LIVE_VOICE_AUDIO_FORMAT, LiveVoiceAudioCapture } =
  await import("@/domains/chat/voice/live-voice/pcm-capture");

// ---------------------------------------------------------------------------
// Browser audio API fakes
//
// happy-dom does not implement Web Audio, so we install minimal fakes on
// globalThis. They record lifecycle calls and let the test drive worklet
// messages by hand. The worklet `addModule` is a no-op — the real downsample
// math is exercised by feeding Int16 buffers through `port.onmessage`.
// ---------------------------------------------------------------------------

interface FakeTrack {
  stopped: boolean;
  stop: () => void;
}

class FakeMediaStream {
  tracks: FakeTrack[] = [{ stopped: false, stop() {} }];
  constructor() {
    for (const t of this.tracks) t.stop = () => (t.stopped = true);
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakePort {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  /** Simulate the worklet posting a PCM chunk to the main thread. */
  emit(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf } as MessageEvent<ArrayBuffer>);
  }
}

class FakeAudioWorkletNode {
  port = new FakePort();
  connected = false;
  disconnect(): void {
    this.connected = false;
  }
}

let lastWorklet: FakeAudioWorkletNode | null = null;

class FakeSourceNode {
  connect(node: FakeAudioWorkletNode): void {
    node.connected = true;
  }
  disconnect(): void {}
}

class FakeAudioContext {
  static lastInstance: FakeAudioContext | null = null;
  closed = false;
  addModuleCalls: string[] = [];
  audioWorklet = {
    addModule: (url: string) => {
      this.addModuleCalls.push(url);
      return Promise.resolve();
    },
  };
  constructor() {
    FakeAudioContext.lastInstance = this;
  }
  createMediaStreamSource(): FakeSourceNode {
    return new FakeSourceNode();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

let getUserMediaImpl: () => Promise<FakeMediaStream> = () =>
  Promise.resolve(new FakeMediaStream());

function installAudioGlobals(): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => getUserMediaImpl(),
      },
    },
  });
  (globalThis as Record<string, unknown>).AudioContext =
    FakeAudioContext as unknown;
  (globalThis as Record<string, unknown>).AudioWorkletNode = function (
    this: FakeAudioWorkletNode,
  ) {
    const node = new FakeAudioWorkletNode();
    lastWorklet = node;
    return node;
  } as unknown;
  // `start()` calls `isSupported()`, which probes AudioContext.prototype.
  (FakeAudioContext.prototype as unknown as Record<string, unknown>).audioWorklet =
    {};
}

beforeEach(() => {
  lastWorklet = null;
  FakeAudioContext.lastInstance = null;
  audioSessionCalls.length = 0;
  activateCallCount = 0;
  gatedActivateCall = null;
  gate = null;
  getUserMediaImpl = () => Promise.resolve(new FakeMediaStream());
  installAudioGlobals();
});

afterEach(() => {
  mock.restore();
});

describe("LIVE_VOICE_AUDIO_FORMAT", () => {
  test("matches the runtime start-frame contract (audio/pcm, 16kHz, mono)", () => {
    expect(LIVE_VOICE_AUDIO_FORMAT).toEqual({
      mimeType: "audio/pcm",
      sampleRate: 16000,
      channels: 1,
    });
  });
});

describe("pcm-downsample worklet (cross-quantum continuity)", () => {
  // The worklet module references the AudioWorkletGlobalScope globals
  // (`sampleRate`, `AudioWorkletProcessor`, `registerProcessor`) at import
  // time. Stub them so we can import the processor and drive `process()` with
  // consecutive 128-frame render quanta, the way the audio thread would.
  interface ProcessorLike {
    process(inputs: Float32Array[][]): boolean;
  }

  async function loadProcessor(
    contextSampleRate: number,
    onChunk: (buf: ArrayBuffer) => void,
  ): Promise<ProcessorLike> {
    const g = globalThis as Record<string, unknown>;
    g.sampleRate = contextSampleRate;
    g.AudioWorkletProcessor = class {
      port = {
        postMessage: (buf: ArrayBuffer) => onChunk(buf),
      };
    };
    let Ctor: (new () => ProcessorLike) | null = null;
    g.registerProcessor = (_name: string, ctor: new () => ProcessorLike) => {
      Ctor = ctor;
    };
    // Cache-bust so each test gets a fresh module evaluation / processor.
    const mod = `./pcm-downsample-worklet.ts?t=${Math.random()}`;
    await import(mod);
    if (!Ctor) throw new Error("processor not registered");
    return new (Ctor as new () => ProcessorLike)();
  }

  test("48kHz: consecutive 128-frame blocks stay continuous (no zeros, no dropped boundary samples)", async () => {
    const chunks: number[] = [];
    // Distinct, non-zero per-sample values so we can detect both injected
    // zeros and skipped boundary samples. A linear ramp at full scale would
    // clip, so keep values in (0, 1].
    const processor = await loadProcessor(48000, (buf) => {
      for (const v of new Int16Array(buf)) chunks.push(v);
    });

    const BLOCK = 128;
    const RATIO = 3; // 48000 / 16000
    const BLOCKS = 5;

    // Build the full input stream and feed it block-by-block.
    const total = BLOCK * BLOCKS;
    const full = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      // Map index -> a positive Float32 sample that round-trips to a unique,
      // non-zero Int16 so any injected zero or dropped sample is observable.
      full[i] = ((i % 1000) + 1) / 2000; // in (0, 0.5]
    }

    for (let b = 0; b < BLOCKS; b++) {
      const block = full.subarray(b * BLOCK, (b + 1) * BLOCK);
      processor.process([[block]]);
    }

    // The streamed result must equal a single-shot decimation of the whole
    // input: positions 0, 3, 6, ... with no gaps and no leading/boundary zero.
    const expected: number[] = [];
    for (let pos = 0; pos < total; pos += RATIO) {
      const clamped = Math.min(1, Math.max(-1, full[Math.floor(pos)]!));
      const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      // Int16Array stores integers (truncates toward zero on assignment).
      expected.push(Math.trunc(scaled));
    }

    expect(chunks).toEqual(expected);
    // No artificial silence injected at block boundaries.
    expect(chunks.some((v) => v === 0)).toBe(false);
  });
});

describe("isSupported", () => {
  test("true when media + worklet APIs are present", () => {
    expect(isSupported()).toBe(true);
  });

  test("false when getUserMedia is missing", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: {} },
    });
    expect(isSupported()).toBe(false);
  });
});

describe("permission handling", () => {
  test("surfaces NotAllowedError as a typed permission-denied result", async () => {
    getUserMediaImpl = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const result = await capture.start();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("permission-denied");
    // No AudioContext should have been constructed on the denied path.
    expect(FakeAudioContext.lastInstance).toBeNull();
  });

  test("maps NotFoundError to no-device", async () => {
    getUserMediaImpl = () =>
      Promise.reject(new DOMException("none", "NotFoundError"));
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const result = await capture.start();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no-device");
  });
});

describe("lifecycle", () => {
  test("start builds the graph and loads the worklet module", async () => {
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const result = await capture.start();

    expect(result.ok).toBe(true);
    const ctx = FakeAudioContext.lastInstance!;
    expect(ctx.addModuleCalls.length).toBe(1);
    expect(lastWorklet?.connected).toBe(true);
  });

  test("stop releases the mic track and closes the context", async () => {
    const stream = new FakeMediaStream();
    getUserMediaImpl = () => Promise.resolve(stream);
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    await capture.start();
    const ctx = FakeAudioContext.lastInstance!;
    await capture.stop();

    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  test("shutdown releases resources and blocks restart", async () => {
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });
    await capture.start();
    await capture.shutdown();

    const result = await capture.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unsupported");
  });

  test("stop() while start()'s getUserMedia is pending cancels the start (mic stays off)", async () => {
    const chunks: ArrayBuffer[] = [];
    const stream = new FakeMediaStream();
    let resolveGum: (s: FakeMediaStream) => void = () => {};
    getUserMediaImpl = () =>
      new Promise<FakeMediaStream>((resolve) => {
        resolveGum = resolve;
      });

    const capture = new LiveVoiceAudioCapture({ onChunk: (b) => chunks.push(b) });

    // Kick off start(); it parks on the pending getUserMedia.
    const startPromise = capture.start();
    // User cancels before the mic resolves.
    await capture.stop();
    // The mic finally resolves after the cancel.
    resolveGum(stream);
    const result = await startPromise;

    // start() must report it was aborted and not wire up the graph.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("aborted");
    // The late-arriving stream's track must be stopped, not left live.
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    // No worklet should have been attached, so no chunks can flow.
    expect(lastWorklet).toBeNull();
    // Driving any worklet that might exist emits nothing.
    expect(chunks.length).toBe(0);
  });

  test("worklet quanta are coalesced into 800-sample batches", async () => {
    const chunks: ArrayBuffer[] = [];
    const capture = new LiveVoiceAudioCapture({ onChunk: (b) => chunks.push(b) });
    await capture.start();

    // 10 quanta of 128 samples = 1280: one full batch plus a 480-sample
    // tail held in the accumulator. Each quantum is filled with its ordinal
    // so boundary continuity is observable.
    for (let i = 0; i < 10; i++) {
      const quantum = new Int16Array(128).fill(i + 1);
      lastWorklet!.port.emit(quantum.buffer);
    }

    expect(chunks.length).toBe(1);
    const batch = new Int16Array(chunks[0]!);
    expect(batch.length).toBe(800);
    // Continuity across quantum boundaries: index 128k..128(k+1) holds
    // quantum k+1's fill value, uninterrupted through the batch.
    expect(batch[0]).toBe(1);
    expect(batch[127]).toBe(1);
    expect(batch[128]).toBe(2);
    expect(batch[799]).toBe(7);
  });

  test("flush() emits the sub-batch tail synchronously and resets", async () => {
    const chunks: ArrayBuffer[] = [];
    const capture = new LiveVoiceAudioCapture({ onChunk: (b) => chunks.push(b) });
    await capture.start();

    lastWorklet!.port.emit(new Int16Array([1, 2, 3]).buffer);
    expect(chunks.length).toBe(0); // held in the accumulator

    capture.flush();
    expect(chunks.length).toBe(1);
    expect(new Int16Array(chunks[0]!)).toEqual(new Int16Array([1, 2, 3]));

    // The accumulator was reset: a second flush emits nothing.
    capture.flush();
    expect(chunks.length).toBe(1);
  });
});

describe("native audio session (iOS echo cancellation)", () => {
  /** Records `getUserMedia` in the same log as the audio-session calls. */
  function recordGetUserMedia(stream = new FakeMediaStream()) {
    getUserMediaImpl = () => {
      audioSessionCalls.push("getUserMedia");
      return Promise.resolve(stream);
    };
    return stream;
  }

  test("activates before opening the mic, then re-asserts once the stream is live", async () => {
    recordGetUserMedia();
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const result = await capture.start();

    expect(result.ok).toBe(true);
    // The first activate must precede getUserMedia — configuring the session
    // after WebKit has built its capture unit is too late for that stream.
    // The second re-asserts the mode WebKit may have dropped when capture
    // started.
    expect(audioSessionCalls).toEqual([
      "activate",
      "getUserMedia",
      "activate",
    ]);
  });

  test("deactivates when the session's capture is torn down", async () => {
    recordGetUserMedia();
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });
    await capture.start();
    audioSessionCalls.length = 0;

    await capture.stop();

    expect(audioSessionCalls).toEqual(["deactivate"]);
  });

  test("deactivates when the mic is denied, leaving no session held", async () => {
    getUserMediaImpl = () => {
      audioSessionCalls.push("getUserMedia");
      return Promise.reject(new DOMException("denied", "NotAllowedError"));
    };
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const result = await capture.start();

    expect(result.ok).toBe(false);
    expect(audioSessionCalls).toEqual([
      "activate",
      "getUserMedia",
      "deactivate",
    ]);
  });

  test("a stop() during the post-getUserMedia re-assert releases the mic without waiting on the bridge", async () => {
    const stream = recordGetUserMedia();
    gate = makeGate();
    gatedActivateCall = 2; // park the re-assert that follows getUserMedia
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const startPromise = capture.start();
    await flushMicrotasks();
    expect(audioSessionCalls).toEqual(["activate", "getUserMedia", "activate"]);

    // The mic is open but the native call has not answered. A stop() here must
    // release it immediately — the capture has to own the stream before the
    // round-trip, or the mic stays live for however long the bridge takes.
    const stopPromise = capture.stop();
    await flushMicrotasks();
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);

    gate.resolve();
    const result = await startPromise;
    await stopPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("aborted");
    // The late activate resolved after teardown's deactivate; the session must
    // not be left held with no owner.
    expect(audioSessionCalls.at(-1)).toBe("deactivate");
  });

  test("deactivates when a stop() cancels an in-flight start", async () => {
    const stream = new FakeMediaStream();
    let resolveGum: (s: FakeMediaStream) => void = () => {};
    getUserMediaImpl = () =>
      new Promise<FakeMediaStream>((resolve) => {
        resolveGum = resolve;
      });
    const capture = new LiveVoiceAudioCapture({ onChunk: () => {} });

    const startPromise = capture.start();
    await capture.stop();
    resolveGum(stream);
    await startPromise;

    // Whatever the interleaving, the cancelled start must not leave the audio
    // session held in the duplex category.
    expect(audioSessionCalls.at(-1)).toBe("deactivate");
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });
});

describe("amplitude", () => {
  test("computes smoothed RMS in [0, 1] from Int16 PCM", async () => {
    const amps: number[] = [];
    const capture = new LiveVoiceAudioCapture({
      onChunk: () => {},
      onAmplitude: (a) => amps.push(a),
    });
    await capture.start();

    // Full-scale samples -> RMS ~1.0 -> clamped to 1.0 after scaling.
    const loud = new Int16Array([32767, -32768, 32767, -32768]).buffer;
    lastWorklet!.port.emit(loud);

    expect(amps.length).toBe(1);
    expect(amps[0]!).toBeGreaterThan(0);
    expect(amps[0]!).toBeLessThanOrEqual(1.0);
  });

  test("silence yields zero amplitude", async () => {
    const amps: number[] = [];
    const capture = new LiveVoiceAudioCapture({
      onChunk: () => {},
      onAmplitude: (a) => amps.push(a),
    });
    await capture.start();

    lastWorklet!.port.emit(new Int16Array([0, 0, 0, 0]).buffer);

    expect(amps[0]).toBe(0);
  });
});
