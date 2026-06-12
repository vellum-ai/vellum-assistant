import { beforeEach, describe, expect, test } from "bun:test";

import {
  LiveVoiceAudioPlayer,
  STOP_FADE_OUT_SECONDS,
  decodePcm16Base64,
  type AudioContextLike,
  type GainNodeLike,
} from "@/domains/chat/voice/live-voice/tts-playback";

// ---------------------------------------------------------------------------
// Mock Web Audio surface
//
// The codebase has no audio mocking helper (this is the first audio module),
// so we hand-roll a minimal AudioContext that records scheduled sources and
// lets a test fire `onended` to simulate a buffer finishing.
// ---------------------------------------------------------------------------

interface MockSource {
  buffer: AudioBuffer | null;
  startedAt: number | null;
  stopped: boolean;
  /** Time passed to stop(when), or currentTime for a bare stop(). */
  stoppedAt: number | null;
  disconnected: boolean;
  /** Node the source was connected to (the master gain, normally). */
  connectedTo: unknown;
  onended: (() => void) | null;
  /** Fire the ended handler as the engine would when the buffer finishes. */
  finish(): void;
}

/** A single scheduled AudioParam automation call, in call order. */
interface MockParamEvent {
  method: "setValueAtTime" | "linearRampToValueAtTime" | "cancelScheduledValues";
  value?: number;
  time: number;
}

class MockGainNode implements GainNodeLike {
  connectedTo: unknown = null;
  readonly events: MockParamEvent[] = [];
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number, time: number) => {
      this.events.push({ method: "setValueAtTime", value, time });
      this.gain.value = value;
    },
    linearRampToValueAtTime: (value: number, time: number) => {
      this.events.push({ method: "linearRampToValueAtTime", value, time });
      this.gain.value = value;
    },
    cancelScheduledValues: (time: number) => {
      this.events.push({ method: "cancelScheduledValues", time });
    },
  };

  connect(destination: AudioNode): void {
    this.connectedTo = destination;
  }

  disconnect(): void {
    this.connectedTo = null;
  }
}

class MockAudioContext {
  currentTime = 0;
  closed = false;
  readonly sources: MockSource[] = [];
  readonly gains: MockGainNode[] = [];

  /** ArrayBuffers passed to decodeAudioData, in call order. */
  readonly decodedInputs: ArrayBuffer[] = [];
  /**
   * Override to control container-decode results in a test. Defaults to a
   * 1.0s 48 kHz buffer so a decoded frame schedules like the PCM frames.
   */
  decodeAudioDataImpl: (audioData: ArrayBuffer) => Promise<AudioBuffer> = () =>
    Promise.resolve(this.createBuffer(1, 48000, 48000));

  constructor(readonly sampleRate = 48000) {}

  readonly destination = {} as AudioNode;

  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer> {
    this.decodedInputs.push(audioData);
    return this.decodeAudioDataImpl(audioData);
  }

  createBuffer(
    _channels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    const channel = new Float32Array(length);
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      numberOfChannels: 1,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const getCurrentTime = () => this.currentTime;
    const source: MockSource = {
      buffer: null,
      startedAt: null,
      stopped: false,
      stoppedAt: null,
      disconnected: false,
      connectedTo: null,
      onended: null,
      finish() {
        this.stopped = true;
        this.onended?.();
      },
    };
    const node = {
      get buffer() {
        return source.buffer;
      },
      set buffer(b: AudioBuffer | null) {
        source.buffer = b;
      },
      get onended() {
        return source.onended;
      },
      set onended(cb: (() => void) | null) {
        source.onended = cb;
      },
      connect(destination: unknown) {
        source.connectedTo = destination;
      },
      disconnect() {
        source.disconnected = true;
      },
      start(when?: number) {
        source.startedAt = when ?? getCurrentTime();
      },
      stop(when?: number) {
        source.stopped = true;
        source.stoppedAt = when ?? getCurrentTime();
      },
    } as unknown as AudioBufferSourceNode;
    this.sources.push(source);
    return node;
  }

  createGain(): GainNodeLike {
    const gain = new MockGainNode();
    this.gains.push(gain);
    return gain;
  }

  /** The master gain node the player created (lazily, with the context). */
  get masterGain(): MockGainNode {
    if (!this.gains[0]) throw new Error("no gain node created yet");
    return this.gains[0];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Build a base64 string from raw little-endian int16 samples. */
function encodePcm16Base64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => {
    const v = s < 0 ? s + 0x10000 : s;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  });
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makePlayer(): {
  player: LiveVoiceAudioPlayer;
  ctx: MockAudioContext;
} {
  const ctx = new MockAudioContext();
  const player = new LiveVoiceAudioPlayer({
    audioContextFactory: () => ctx as unknown as AudioContextLike,
  });
  return { player, ctx };
}

function chunk(samples: number[], sampleRate = 24000): {
  dataBase64: string;
  sampleRate: number;
  mimeType: string;
} {
  return {
    dataBase64: encodePcm16Base64(samples),
    sampleRate,
    mimeType: "audio/pcm",
  };
}

/** Drain the microtask queue so serialized async decodes settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Build a frame with an arbitrary mimeType and opaque (non-PCM) payload. */
function frame(
  mimeType: string,
  dataBase64 = btoa("opaque-container-bytes"),
): { dataBase64: string; sampleRate: number; mimeType: string } {
  return { dataBase64, sampleRate: 24000, mimeType };
}

// ---------------------------------------------------------------------------
// decode correctness
// ---------------------------------------------------------------------------

describe("decodePcm16Base64", () => {
  test("decodes known little-endian int16 PCM into normalized floats", () => {
    // 0, full-scale positive (32767), full-scale negative (-32768), -1.
    const base64 = encodePcm16Base64([0, 32767, -32768, -1]);
    const out = decodePcm16Base64(base64);

    expect(out.length).toBe(4);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(32767 / 32768, 6);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBeCloseTo(-1 / 32768, 6);
  });

  test("returns empty array for empty input", () => {
    expect(decodePcm16Base64("").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// playback queue
// ---------------------------------------------------------------------------

describe("LiveVoiceAudioPlayer", () => {
  let player: LiveVoiceAudioPlayer;
  let ctx: MockAudioContext;

  beforeEach(() => {
    ({ player, ctx } = makePlayer());
  });

  test("schedules chunks in order, gaplessly, at the frame sample rate", () => {
    // Two 24 kHz frames of 24000 samples each => 1.0s buffers.
    player.enqueue(chunk(new Array(24000).fill(100)));
    player.enqueue(chunk(new Array(24000).fill(200)));

    expect(ctx.sources.length).toBe(2);
    // First starts now (currentTime 0).
    expect(ctx.sources[0]!.startedAt).toBe(0);
    // Second is chained to start exactly when the first ends — gapless.
    expect(ctx.sources[1]!.startedAt).toBeCloseTo(1.0, 6);
    // Buffers were built at the frame's own 24 kHz rate, not the 48 kHz ctx.
    expect(ctx.sources[0]!.buffer!.sampleRate).toBe(24000);

    expect(player.isPlaying).toBe(true);
  });

  test("never schedules in the past after the queue lags currentTime", () => {
    player.enqueue(chunk(new Array(24000).fill(1))); // 1.0s buffer at t=0
    // Advance the clock past the scheduled tail, then enqueue again.
    ctx.currentTime = 5;
    player.enqueue(chunk(new Array(24000).fill(1)));

    expect(ctx.sources[1]!.startedAt).toBe(5);
  });

  test("isPlaying stays true until the last source finishes", () => {
    player.enqueue(chunk(new Array(12000).fill(1)));
    player.enqueue(chunk(new Array(12000).fill(1)));
    expect(player.isPlaying).toBe(true);

    // First of two buffers finishing leaves playback active.
    ctx.sources[0]!.finish();
    expect(player.isPlaying).toBe(true);

    // The last buffer finishing clears playback.
    ctx.sources[1]!.finish();
    expect(player.isPlaying).toBe(false);
  });

  test("stop() halts every source at the end of the fade and clears the queue", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    player.enqueue(chunk(new Array(24000).fill(1)));

    player.stop();

    // Sources are scheduled to halt when the 20ms gain fade completes — an
    // immediate stop would produce an audible click.
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(
      ctx.sources.every((s) => s.stoppedAt === STOP_FADE_OUT_SECONDS),
    ).toBe(true);
    expect(player.isPlaying).toBe(false);
  });

  test("stop() ramps the master gain to silence over the fade window", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    ctx.currentTime = 0.5;

    player.stop();

    const ramp = ctx.masterGain.events.find(
      (e) => e.method === "linearRampToValueAtTime",
    );
    expect(ramp).toEqual({
      method: "linearRampToValueAtTime",
      value: 0,
      time: 0.5 + STOP_FADE_OUT_SECONDS,
    });
  });

  test("enqueue after stop() restores the gain to the user's level", () => {
    player.setVolume(0.4);
    player.enqueue(chunk(new Array(24000).fill(1)));
    player.stop();
    expect(ctx.masterGain.gain.value).toBe(0);

    player.enqueue(chunk(new Array(24000).fill(1)));
    expect(ctx.masterGain.gain.value).toBe(0.4);
  });

  test("stop() without active sources leaves the gain untouched", () => {
    player.enqueue(chunk(new Array(12000).fill(1)));
    ctx.sources[0]!.finish();

    player.stop();

    const ramp = ctx.masterGain.events.find(
      (e) => e.method === "linearRampToValueAtTime",
    );
    expect(ramp).toBeUndefined();
  });

  test("playhead resets after stop so the next enqueue starts fresh", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    player.stop();
    player.enqueue(chunk(new Array(24000).fill(1)));

    // The newly scheduled source (index 1) starts at currentTime, not chained
    // after the flushed buffer.
    expect(ctx.sources[1]!.startedAt).toBe(0);
  });

  test("waitUntilDrained() resolves when the queue empties", async () => {
    player.enqueue(chunk(new Array(12000).fill(1)));
    player.enqueue(chunk(new Array(12000).fill(1)));

    let drained = false;
    const promise = player.waitUntilDrained().then(() => {
      drained = true;
    });

    ctx.sources[0]!.finish();
    expect(drained).toBe(false);

    ctx.sources[1]!.finish();
    await promise;
    expect(drained).toBe(true);
  });

  test("waitUntilDrained() resolves immediately when idle", async () => {
    await expect(player.waitUntilDrained()).resolves.toBeUndefined();
  });

  test("waitUntilDrained() resolves on stop() (barge-in)", async () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    const promise = player.waitUntilDrained();
    player.stop();
    await expect(promise).resolves.toBeUndefined();
  });

  test("drops empty/malformed chunks without scheduling", () => {
    player.enqueue(chunk([]));
    expect(ctx.sources.length).toBe(0);
    expect(player.isPlaying).toBe(false);
  });

  // -------------------------------------------------------------------------
  // master gain: routing, volume, mute
  // -------------------------------------------------------------------------

  test("sources play through the master gain, which feeds the destination", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));

    expect(ctx.gains.length).toBe(1);
    expect(ctx.masterGain.connectedTo).toBe(ctx.destination);
    expect(ctx.sources[0]!.connectedTo).toBe(ctx.masterGain);
  });

  test("constructor volume/muted seed the master gain", () => {
    const seeded = new LiveVoiceAudioPlayer({
      audioContextFactory: () => ctx as unknown as AudioContextLike,
      volume: 0.6,
      muted: true,
    });
    seeded.enqueue(chunk(new Array(24000).fill(1)));

    // Muted wins: the gain starts silent even with a non-zero volume.
    expect(ctx.masterGain.gain.value).toBe(0);

    seeded.setMuted(false);
    expect(ctx.masterGain.gain.value).toBe(0.6);
  });

  test("setVolume applies live to playing audio and clamps to [0, 1]", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));

    player.setVolume(0.25);
    expect(ctx.masterGain.gain.value).toBe(0.25);

    player.setVolume(7);
    expect(ctx.masterGain.gain.value).toBe(1);

    player.setVolume(-3);
    expect(ctx.masterGain.gain.value).toBe(0);
  });

  test("setMuted silences and restores without touching the volume", () => {
    player.setVolume(0.8);
    player.enqueue(chunk(new Array(24000).fill(1)));

    player.setMuted(true);
    expect(ctx.masterGain.gain.value).toBe(0);

    player.setMuted(false);
    expect(ctx.masterGain.gain.value).toBe(0.8);
  });

  // -------------------------------------------------------------------------
  // mimeType-gated decode routing
  // -------------------------------------------------------------------------

  test("audio/pcm frames take the synchronous raw-PCM fast path", () => {
    player.enqueue(chunk(new Array(24000).fill(100)));

    // Scheduled synchronously, built at the frame's own rate, no container
    // decode invoked.
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0]!.buffer!.sampleRate).toBe(24000);
    expect(ctx.decodedInputs.length).toBe(0);
  });

  test("audio/wav frames route through decodeAudioData (container path)", async () => {
    const decoded = ctx.createBuffer(1, 48000, 48000);
    let decodeCalls = 0;
    ctx.decodeAudioDataImpl = () => {
      decodeCalls += 1;
      return Promise.resolve(decoded);
    };

    player.enqueue(frame("audio/wav"));

    // Decode is invoked with the raw container bytes; scheduling happens after
    // the async decode resolves.
    expect(ctx.sources.length).toBe(0);

    await flushMicrotasks();

    expect(ctx.decodedInputs.length).toBe(1);
    expect(decodeCalls).toBe(1);
    expect(ctx.sources.length).toBe(1);
    // The buffer's rate comes from the container (decodeAudioData), not 24 kHz.
    expect(ctx.sources[0]!.buffer!.sampleRate).toBe(48000);
    expect(ctx.sources[0]!.startedAt).toBe(0);
  });

  test("container frames are decoded with a wav mimeType too (params stripped)", async () => {
    player.enqueue(frame("audio/wav; codecs=1"));
    await flushMicrotasks();
    expect(ctx.decodedInputs.length).toBe(1);
  });

  test("unknown mimeType is skipped: no decode, no scheduled buffer", async () => {
    player.enqueue(frame("application/octet-stream"));
    await flushMicrotasks();

    expect(ctx.decodedInputs.length).toBe(0);
    expect(ctx.sources.length).toBe(0);
    expect(player.isPlaying).toBe(false);
  });

  test("waitUntilDrained() waits for a pending container decode to schedule+finish", async () => {
    // A container frame whose decode we hold open: tts_done can arrive while
    // it's still decoding, and drain must not resolve until it has been
    // scheduled AND the scheduled source has finished.
    let resolveDecode!: (buffer: AudioBuffer) => void;
    ctx.decodeAudioDataImpl = () =>
      new Promise<AudioBuffer>((resolve) => {
        resolveDecode = resolve;
      });

    player.enqueue(frame("audio/wav"));
    expect(ctx.sources.length).toBe(0);
    // Pending decode counts as active even before any source is scheduled.
    expect(player.isPlaying).toBe(true);

    let drained = false;
    const promise = player.waitUntilDrained().then(() => {
      drained = true;
    });

    // Still decoding: drain must not resolve.
    await flushMicrotasks();
    expect(drained).toBe(false);

    // Decode resolves -> the buffer is scheduled.
    resolveDecode(ctx.createBuffer(1, 48000, 48000));
    await flushMicrotasks();
    expect(ctx.sources.length).toBe(1);
    // Scheduled but not finished: still not drained.
    expect(drained).toBe(false);

    // Source finishes -> now drained.
    ctx.sources[0]!.finish();
    await promise;
    expect(drained).toBe(true);
  });

  test("stop() invalidates a pending container decode: it never schedules, and drain resolves", async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    ctx.decodeAudioDataImpl = () =>
      new Promise<AudioBuffer>((resolve) => {
        resolveDecode = resolve;
      });

    player.enqueue(frame("audio/wav"));
    const promise = player.waitUntilDrained();

    // Barge-in / manual stop while the decode is still in flight.
    player.stop();
    await expect(promise).resolves.toBeUndefined();
    expect(player.isPlaying).toBe(false);

    // The decode resolves only after stop(): the stale buffer must be dropped,
    // not scheduled over the now-open mic.
    resolveDecode(ctx.createBuffer(1, 48000, 48000));
    await flushMicrotasks();
    expect(ctx.sources.length).toBe(0);
    expect(player.isPlaying).toBe(false);
  });

  test("a failed container decode skips the frame without throwing", async () => {
    ctx.decodeAudioDataImpl = () => Promise.reject(new Error("bad container"));

    player.enqueue(frame("audio/wav"));
    await flushMicrotasks();

    expect(ctx.sources.length).toBe(0);
    expect(player.isPlaying).toBe(false);
  });

  // -------------------------------------------------------------------------
  // dispose: release the underlying AudioContext (resource-leak guard)
  // -------------------------------------------------------------------------

  test("dispose() stops playback and closes the underlying context", async () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    player.enqueue(chunk(new Array(24000).fill(1)));
    expect(player.isPlaying).toBe(true);

    await player.dispose();

    // Every scheduled source was halted, the queue cleared, and the context
    // released so it can't leak across repeated sessions.
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(player.isPlaying).toBe(false);
  });

  test("dispose() is a no-op when no context was ever created", async () => {
    // No enqueue, so the lazy context was never constructed: dispose must not
    // throw and must not fabricate/close a context.
    await player.dispose();
    expect(ctx.closed).toBe(false);
  });

  test("dispose() is idempotent: repeat calls don't re-close the context", async () => {
    player.enqueue(chunk(new Array(24000).fill(1)));

    await player.dispose();
    ctx.closed = false; // detect any erroneous second close
    await player.dispose();

    expect(ctx.closed).toBe(false);
  });

  test("player is reusable after dispose() — the next enqueue recreates context", async () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    await player.dispose();

    // A fresh enqueue lazily rebuilds a context and schedules normally.
    player.enqueue(chunk(new Array(24000).fill(1)));
    expect(player.isPlaying).toBe(true);
  });
});
