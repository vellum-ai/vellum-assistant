import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  LiveVoiceAudioPlayer,
  decodePcm16Base64,
  type AudioContextLike,
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
  connectedTo: AudioNode | null;
  startedAt: number | null;
  stopped: boolean;
  disconnected: boolean;
  onended: (() => void) | null;
  /** Fire the ended handler as the engine would when the buffer finishes. */
  finish(): void;
}

class MockAudioContext {
  currentTime = 0;
  closed = false;
  state: AudioContextState = "suspended";
  resumeCount = 0;
  readonly sources: MockSource[] = [];
  mediaStreamDestinationCreateCount = 0;
  readonly mediaStreamTrack = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  readonly mediaStream = {
    getTracks: () => [this.mediaStreamTrack],
  } as unknown as MediaStream;
  readonly mediaStreamDestination = {
    stream: this.mediaStream,
  } as unknown as MediaStreamAudioDestinationNode;

  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }

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
      connectedTo: null,
      startedAt: null,
      stopped: false,
      disconnected: false,
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
      connect(destination: AudioNode) {
        source.connectedTo = destination;
      },
      disconnect() {
        source.disconnected = true;
      },
      start(when?: number) {
        source.startedAt = when ?? getCurrentTime();
      },
      stop() {
        source.stopped = true;
      },
    } as unknown as AudioBufferSourceNode;
    this.sources.push(source);
    return node;
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    this.mediaStreamDestinationCreateCount += 1;
    return this.mediaStreamDestination;
  }

  /** Records the gain stage the output mute rides on. */
  gain: { gain: { value: number }; connectedTo: AudioNode | null } | null =
    null;

  createGain(): GainNode {
    const node = {
      gain: { value: 1 },
      connectedTo: null as AudioNode | null,
      connect(destination: AudioNode) {
        node.connectedTo = destination;
      },
      disconnect() {
        node.connectedTo = null;
      },
    };
    this.gain = node;
    return node as unknown as GainNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockMediaStreamPlaybackElement {
  srcObject: HTMLMediaElement["srcObject"] = null;
  playCount = 0;
  pauseCount = 0;
  paused = true;
  readyState = 0;
  /** Leave `play()` unsettled, as it is on a real element until playback starts. */
  deferPlay = false;

  private pendingResolve: (() => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;

  constructor(private readonly playError?: Error) {}

  play(): Promise<void> {
    this.playCount += 1;
    if (this.playError) {
      return Promise.reject(this.playError);
    }
    if (this.deferPlay) {
      return new Promise<void>((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;
      });
    }
    this.startedPlaying();
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
    // Pausing rejects a `play()` still in flight with `AbortError`, which is
    // what makes a deliberate restart look like a refused route unless the
    // player tracks which attempt a rejection belongs to.
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    if (reject) {
      const aborted = new Error(
        "The play() request was interrupted by pause()",
      );
      aborted.name = "AbortError";
      reject(aborted);
    }
  }

  /** Settle a deferred `play()` as the element beginning playback. */
  settlePlay(): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.startedPlaying();
    resolve?.();
  }

  private startedPlaying(): void {
    this.paused = false;
    this.readyState = 4;
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
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
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

/**
 * Context that also meters, so amplitude paths run for real. Kept separate from
 * {@link MockAudioContext} because adding an analyser moves where sources
 * connect, which the graph-wiring assertions above pin deliberately.
 */
class MeteringMockAudioContext extends MockAudioContext {
  /** Constant sample value the fake analyser reports. */
  level = 0;

  createAnalyser(): AnalyserNode {
    const read = () => this.level;
    return {
      fftSize: 256,
      connect() {},
      disconnect() {},
      getFloatTimeDomainData(target: Float32Array) {
        target.fill(read());
      },
    } as unknown as AnalyserNode;
  }
}

function makeMeteringPlayer(): {
  player: LiveVoiceAudioPlayer;
  ctx: MeteringMockAudioContext;
} {
  const ctx = new MeteringMockAudioContext();
  const player = new LiveVoiceAudioPlayer({
    audioContextFactory: () => ctx as unknown as AudioContextLike,
  });
  return { player, ctx };
}

/**
 * `playErrors` is indexed by element: the player builds a fresh element each
 * time it (re)creates the route, so a refused first attempt can be followed by
 * a successful retry.
 */
function makeMediaStreamPlayer(...playErrors: (Error | undefined)[]): {
  player: LiveVoiceAudioPlayer;
  ctx: MockAudioContext;
  mediaElement: MockMediaStreamPlaybackElement;
  elements: MockMediaStreamPlaybackElement[];
} {
  const ctx = new MockAudioContext();
  // The first element is built up front so tests can hold a reference to it
  // before the player asks for one.
  const elements = [new MockMediaStreamPlaybackElement(playErrors[0])];
  let handedOut = 0;
  const player = new LiveVoiceAudioPlayer({
    audioContextFactory: () => ctx as unknown as AudioContextLike,
    useMediaStreamOutput: true,
    mediaStreamPlaybackElementFactory: () => {
      if (handedOut < elements.length) {
        return elements[handedOut++]!;
      }
      const element = new MockMediaStreamPlaybackElement(playErrors[handedOut]);
      elements.push(element);
      handedOut++;
      return element;
    },
  });
  return { player, ctx, elements, mediaElement: elements[0]! };
}

function chunk(
  samples: number[],
  sampleRate = 24000,
): {
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
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
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

  test("prewarm resumes a suspended context up front", () => {
    // A fresh context starts suspended (browser autoplay policy); if it's only
    // created lazily on the first frame it never plays, dropping the first turn.
    expect(ctx.state).toBe("suspended");

    player.prewarm();

    expect(ctx.resumeCount).toBe(1);
    expect(ctx.state).toBe("running");
  });

  test("prewarm is idempotent once the context is running", () => {
    player.prewarm();
    player.prewarm();
    expect(ctx.resumeCount).toBe(1);
  });

  test("Capacitor iOS routes TTS through a playing MediaStream track", () => {
    const {
      player: mediaStreamPlayer,
      ctx: mediaStreamContext,
      mediaElement,
    } = makeMediaStreamPlayer();

    mediaStreamPlayer.prewarm();
    mediaStreamPlayer.enqueue(chunk(new Array(24000).fill(100)));

    expect(mediaStreamContext.mediaStreamDestinationCreateCount).toBe(1);
    expect(mediaElement.srcObject).toBe(mediaStreamContext.mediaStream);
    expect(mediaElement.playCount).toBe(1);
    // Sources feed the mute stage, which feeds the MediaStream bus.
    expect(mediaStreamContext.sources[0]!.connectedTo).toBe(
      mediaStreamContext.gain as unknown as AudioNode,
    );
    expect(mediaStreamContext.gain?.connectedTo).toBe(
      mediaStreamContext.mediaStreamDestination,
    );
  });

  test("falls back to direct output when MediaStream playback is rejected", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const {
        player: mediaStreamPlayer,
        ctx: mediaStreamContext,
        mediaElement,
      } = makeMediaStreamPlayer(new Error("playback rejected"));

      mediaStreamPlayer.prewarm();
      await flushMicrotasks();
      mediaStreamPlayer.enqueue(chunk(new Array(24000).fill(100)));

      expect(mediaElement.srcObject).toBeNull();
      expect(mediaStreamContext.mediaStreamTrack.stopped).toBe(true);
      // The mute stage survives the fallback, so a muted session does not
      // start playing aloud because its iOS output route dropped.
      expect(mediaStreamContext.sources[0]!.connectedTo).toBe(
        mediaStreamContext.gain as unknown as AudioNode,
      );
      expect(mediaStreamContext.gain?.connectedTo).toBe(
        mediaStreamContext.destination,
      );
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("restarting the route re-renders the MediaStream track", () => {
    const { player: mediaStreamPlayer, mediaElement } = makeMediaStreamPlayer();

    mediaStreamPlayer.prewarm();
    expect(mediaElement.playCount).toBe(1);

    // Rebinding after getUserMedia has to actually stop and restart the
    // renderer: WebKit attaches the echo reference when a renderer starts, so a
    // no-op "already playing" check would leave it bound to whatever unit
    // existed before the microphone came up.
    mediaStreamPlayer.restartOutputRoute();

    expect(mediaElement.pauseCount).toBe(1);
    expect(mediaElement.playCount).toBe(2);
    expect(mediaElement.paused).toBe(false);
    expect(mediaStreamPlayer.getOutputRouteDiagnostics().route).toBe(
      "media-stream",
    );
  });

  test("a restart's own abort does not tear down the route", async () => {
    const { player: mediaStreamPlayer, mediaElement } = makeMediaStreamPlayer();
    // A real `play()` stays unsettled until playback actually starts, so the
    // prewarm attempt is still in flight when capture comes up.
    mediaElement.deferPlay = true;

    mediaStreamPlayer.prewarm();
    mediaStreamPlayer.restartOutputRoute();
    mediaElement.settlePlay();
    await flushMicrotasks();

    // The pause rejected the prewarm's `play()` with AbortError. Treating that
    // as a refusal would drop the MediaStream route, removing echo cancellation
    // on exactly the sessions this rebind exists to fix.
    expect(mediaStreamPlayer.getOutputRouteDiagnostics()).toMatchObject({
      route: "media-stream",
      playRejectionName: null,
      elementPaused: false,
    });
    expect(mediaElement.srcObject).not.toBeNull();
  });

  test("rebuilds a route the prewarm attempt was refused", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A gesture-less start (Siri, Action Button, Live Activity): the prewarm
      // `play()` is refused outright and the fallback tears the route down.
      const {
        player: mediaStreamPlayer,
        ctx: mediaStreamContext,
        elements,
      } = makeMediaStreamPlayer(new Error("no user activation"));

      mediaStreamPlayer.prewarm();
      await flushMicrotasks();
      expect(mediaStreamPlayer.getOutputRouteDiagnostics().route).toBe(
        "direct",
      );

      // Capture is live now, which is grounds for playing a MediaStream element
      // that an unactivated page could not. Leaving this session on the direct
      // path would strand exactly the starts that most need the retry.
      mediaStreamPlayer.restartOutputRoute();
      await flushMicrotasks();

      expect(elements).toHaveLength(2);
      expect(elements[1]!.playCount).toBe(1);
      expect(mediaStreamPlayer.getOutputRouteDiagnostics().route).toBe(
        "media-stream",
      );
      // Audio reaches the rebuilt bus, with the mute stage still in front of it.
      mediaStreamPlayer.enqueue(chunk(new Array(2400).fill(100)));
      expect(mediaStreamContext.gain?.connectedTo).toBe(
        mediaStreamContext.mediaStreamDestination,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a refused retry degrades to the direct path again", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { player: mediaStreamPlayer, ctx: mediaStreamContext } =
        makeMediaStreamPlayer(
          new Error("no user activation"),
          new Error("still refused"),
        );

      mediaStreamPlayer.prewarm();
      await flushMicrotasks();
      mediaStreamPlayer.restartOutputRoute();
      await flushMicrotasks();

      expect(mediaStreamPlayer.getOutputRouteDiagnostics().route).toBe(
        "direct",
      );
      mediaStreamPlayer.enqueue(chunk(new Array(2400).fill(100)));
      expect(mediaStreamContext.gain?.connectedTo).toBe(
        mediaStreamContext.destination,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("route diagnostics name the rejection that dropped echo cancellation", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rejection = new Error("playback rejected");
      rejection.name = "NotAllowedError";
      const { player: mediaStreamPlayer } = makeMediaStreamPlayer(rejection);

      mediaStreamPlayer.prewarm();
      await flushMicrotasks();

      expect(mediaStreamPlayer.getOutputRouteDiagnostics()).toMatchObject({
        route: "direct",
        mediaStreamRouteRequested: true,
        mediaStreamApiAvailable: true,
        playAttempts: 1,
        playRejectionName: "NotAllowedError",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("route diagnostics distinguish unresolved from unsupported", () => {
    const { player: mediaStreamPlayer } = makeMediaStreamPlayer();
    // Wanted, but no context built yet: reporting "direct" here would read as a
    // failed route rather than one that has not been attempted.
    expect(mediaStreamPlayer.getOutputRouteDiagnostics().route).toBe("pending");

    expect(player.getOutputRouteDiagnostics()).toMatchObject({
      route: "unsupported",
      mediaStreamRouteRequested: false,
    });
  });

  test("route diagnostics report a route that paused itself after starting", () => {
    const { player: mediaStreamPlayer, mediaElement } = makeMediaStreamPlayer();

    mediaStreamPlayer.prewarm();
    // A route accepted at play() and later stopped by the platform still
    // reports "media-stream"; only the live element state reveals it.
    mediaElement.pause();

    expect(mediaStreamPlayer.getOutputRouteDiagnostics()).toMatchObject({
      route: "media-stream",
      elementPaused: true,
    });
  });

  test("reading the output level leaves the avatar's meter untouched", () => {
    const { player: metered, ctx: meteredCtx } = makeMeteringPlayer();
    meteredCtx.level = 0.05;
    metered.enqueue(chunk(new Array(24000).fill(8000)));

    // Non-zero, so what follows is about real metering rather than 0 === 0.
    const instant = metered.readOutputLevel();
    expect(instant).toBeGreaterThan(0);

    // Two consumers on different cadences share this player. The avatar's
    // meter is a stateful EMA advanced by every call, so the measurement path
    // must not read through it: otherwise the probe would drag the avatar's
    // level around, and its own numbers would depend on whether the avatar is
    // mounted at all.
    const first = metered.getOutputAmplitude();
    metered.readOutputLevel();
    metered.readOutputLevel();
    metered.readOutputLevel();
    const second = metered.getOutputAmplitude();

    // One EMA step on from `first`, exactly as if the probe had never read.
    expect(second).toBeCloseTo(0.5 * instant + 0.5 * first, 10);
    // And the pure read is genuinely stateless: same input, same answer.
    expect(metered.readOutputLevel()).toBeCloseTo(instant, 10);
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
    expect(ctx.sources[0]!.connectedTo).toBe(ctx.gain as unknown as AudioNode);
    expect(ctx.gain?.connectedTo).toBe(ctx.destination);

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

  test("stop() halts every source immediately and clears the queue", () => {
    player.enqueue(chunk(new Array(24000).fill(1)));
    player.enqueue(chunk(new Array(24000).fill(1)));

    player.stop();

    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(ctx.sources.every((s) => s.disconnected)).toBe(true);
    expect(player.isPlaying).toBe(false);
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
  // playback progress (spoken-word cursor)
  // -------------------------------------------------------------------------

  describe("getPlaybackProgress", () => {
    test("returns null before any enqueue", () => {
      expect(player.getPlaybackProgress()).toBeNull();
    });

    test("returns null after dispose()", async () => {
      player.enqueue(chunk(new Array(24000).fill(1)));
      await player.dispose();
      expect(player.getPlaybackProgress()).toBeNull();
    });

    test("tracks a single PCM chunk: total is the buffer duration, played follows currentTime", () => {
      // One 24000-sample frame at 24 kHz => 1.0s scheduled at t=0.
      player.enqueue(chunk(new Array(24000).fill(1)));

      expect(player.getPlaybackProgress()).toEqual({
        playedSeconds: 0,
        totalSeconds: 1,
      });

      ctx.currentTime = 0.5;
      expect(player.getPlaybackProgress()!.playedSeconds).toBeCloseTo(0.5, 6);

      // Past the scheduled tail: played clamps to total.
      ctx.currentTime = 3;
      expect(player.getPlaybackProgress()).toEqual({
        playedSeconds: 1,
        totalSeconds: 1,
      });
    });

    test("accumulates totalSeconds across chunks", () => {
      player.enqueue(chunk(new Array(24000).fill(1))); // 1.0s
      player.enqueue(chunk(new Array(12000).fill(1))); // 0.5s

      const progress = player.getPlaybackProgress()!;
      expect(progress.totalSeconds).toBeCloseTo(1.5, 6);
      expect(progress.playedSeconds).toBe(0);
    });

    test("reports played == total after the queue drains (not null)", () => {
      player.enqueue(chunk(new Array(24000).fill(1)));
      ctx.currentTime = 1;
      ctx.sources[0]!.finish(); // drain -> settleIfIdle zeroes the playhead

      // Mid-turn silence: the cursor holds at the end, it doesn't reset.
      expect(player.getPlaybackProgress()).toEqual({
        playedSeconds: 1,
        totalSeconds: 1,
      });
    });

    test("a burst after a drain grows total; the silent gap never counts as played", () => {
      player.enqueue(chunk(new Array(24000).fill(1))); // 1.0s at t=0
      ctx.currentTime = 1;
      ctx.sources[0]!.finish();

      // 4s of silence (ack -> tool run), then a second 1.0s burst at t=5.
      ctx.currentTime = 5;
      player.enqueue(chunk(new Array(24000).fill(1)));

      // total grew to 2.0s; played is still just the first second — the gap
      // between bursts did not inflate it.
      expect(player.getPlaybackProgress()).toEqual({
        playedSeconds: 1,
        totalSeconds: 2,
      });

      ctx.currentTime = 5.5;
      expect(player.getPlaybackProgress()!.playedSeconds).toBeCloseTo(1.5, 6);
    });

    test("stop() resets progress to null", () => {
      player.enqueue(chunk(new Array(24000).fill(1)));
      player.stop();
      expect(player.getPlaybackProgress()).toBeNull();
    });

    test("resetPlaybackProgress() resets progress to null", () => {
      player.enqueue(chunk(new Array(24000).fill(1)));
      player.resetPlaybackProgress();
      expect(player.getPlaybackProgress()).toBeNull();
    });

    test("container path: a resolved async decode contributes its duration to total", async () => {
      player.enqueue(frame("audio/wav"));
      // Not scheduled yet: no progress until the decode resolves.
      expect(player.getPlaybackProgress()).toBeNull();

      await flushMicrotasks();

      // Default mock decode yields a 1.0s buffer.
      expect(player.getPlaybackProgress()).toEqual({
        playedSeconds: 0,
        totalSeconds: 1,
      });
    });
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

  test("dispose() releases the iOS MediaStream output route", async () => {
    const {
      player: mediaStreamPlayer,
      ctx: mediaStreamContext,
      mediaElement,
    } = makeMediaStreamPlayer();
    mediaStreamPlayer.prewarm();

    await mediaStreamPlayer.dispose();

    expect(mediaElement.pauseCount).toBe(1);
    expect(mediaElement.srcObject).toBeNull();
    expect(mediaStreamContext.mediaStreamTrack.stopped).toBe(true);
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

// Muting the assistant is a gain stage, not a stop: the reply keeps being
// scheduled and the transcript keeps filling, so unmuting drops the user back
// into whatever is playing rather than restarting it.
describe("LiveVoiceAudioPlayer output mute", () => {
  test("mute zeroes the output gain and unmute restores it", () => {
    const { player, ctx } = makePlayer();
    player.prewarm();

    player.setOutputMuted(true);
    expect(ctx.gain?.gain.value).toBe(0);
    expect(player.isOutputMuted()).toBe(true);

    player.setOutputMuted(false);
    expect(ctx.gain?.gain.value).toBe(1);
    expect(player.isOutputMuted()).toBe(false);
  });

  test("a mute set before the graph exists applies to the graph it gets", () => {
    // This is the reconnect path: the socket blips, a fresh context is built,
    // and a user who silenced the assistant must not have it start talking
    // again on its own.
    const { player, ctx } = makePlayer();
    player.setOutputMuted(true);
    expect(ctx.gain).toBeNull();

    player.prewarm();
    expect(ctx.gain?.gain.value).toBe(0);
  });

  test("muting does not stop or drop scheduled audio", () => {
    const { player, ctx } = makePlayer();
    player.prewarm();
    player.enqueue({
      dataBase64: encodePcm16Base64([1000, -1000, 500]),
      sampleRate: 24000,
      mimeType: "audio/pcm",
    });
    const scheduled = ctx.sources.length;

    player.setOutputMuted(true);

    expect(ctx.sources.length).toBe(scheduled);
    expect(ctx.sources.every((s) => !s.stopped)).toBe(true);
  });

  test("no gain stage available: records the flag without throwing", () => {
    // A context that cannot make one (lightweight host) simply cannot mute.
    const { player, ctx } = makePlayer();
    const noGain = ctx as unknown as { createGain?: unknown };
    delete noGain.createGain;
    player.prewarm();

    expect(() => player.setOutputMuted(true)).not.toThrow();
    expect(player.isOutputMuted()).toBe(true);
  });
});
