import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  downsampleToInt16,
  isSupported,
  LIVE_VOICE_AUDIO_FORMAT,
  LiveVoiceAudioCapture,
} from "@/domains/voice/live-voice/pcm-capture";

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

describe("downsampleToInt16", () => {
  test("converts a known Float32 input to signed 16-bit at 16kHz (no resample)", () => {
    // inputRate === target: 1:1, exercises just the Float32 -> Int16 scaling.
    const input = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const pcm = downsampleToInt16(input, 16000);
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16383, -16384]);
  });

  test("clamps out-of-range samples to the Int16 bounds", () => {
    const pcm = downsampleToInt16(new Float32Array([2.0, -2.0]), 16000);
    expect(Array.from(pcm)).toEqual([32767, -32768]);
  });

  test("decimates a 32kHz buffer to half the samples", () => {
    const input = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]);
    const pcm = downsampleToInt16(input, 32000);
    // ratio 2 -> 4 output samples, taking every other input (the 1s).
    expect(pcm.length).toBe(4);
    expect(Array.from(pcm)).toEqual([32767, 32767, 32767, 32767]);
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
