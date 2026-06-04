import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  isSupported,
  LIVE_VOICE_AUDIO_FORMAT,
  LiveVoiceAudioCapture,
} from "@/domains/chat/voice/live-voice/pcm-capture";

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

  test("emitted PCM chunks reach onChunk", async () => {
    const chunks: ArrayBuffer[] = [];
    const capture = new LiveVoiceAudioCapture({ onChunk: (b) => chunks.push(b) });
    await capture.start();

    const buf = new Int16Array([1, 2, 3]).buffer;
    lastWorklet!.port.emit(buf);

    expect(chunks.length).toBe(1);
    expect(new Int16Array(chunks[0]!)).toEqual(new Int16Array([1, 2, 3]));
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
