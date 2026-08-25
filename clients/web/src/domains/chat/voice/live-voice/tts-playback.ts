/**
 * Streamed TTS playback queue for the live-voice channel.
 *
 * The server streams text-to-speech audio as `tts_audio` frames whose payload
 * format is advertised per frame via `mimeType`. Two playback paths exist,
 * selected on `mimeType`:
 *
 * - `audio/pcm` — raw little-endian 16-bit PCM (default 24 kHz mono, sample
 *   rate per `chunk.sampleRate`). Decoded synchronously (base64 → `Int16Array`
 *   → `Float32Array`) and scheduled immediately.
 * - Container formats (`audio/wav`, `audio/mpeg`, `audio/opus`) — providers
 *   without raw-PCM streaming (e.g. Fish Audio) fall back to a `wav` container.
 *   These are decoded via the Web Audio `AudioContext.decodeAudioData` path,
 *   which derives sample rate/channels from the container itself. Decoding is
 *   asynchronous, so the start time is reserved up front against the running
 *   playhead to preserve ordering and gaplessness.
 *
 * Unrecognized MIME types are skipped with a logged warning rather than being
 * misdecoded as raw PCM (which would play header/interleaved bytes as garbage).
 *
 * {@link LiveVoiceAudioPlayer} schedules gapless sequential playback through a
 * Web Audio `AudioContext` by chaining `AudioBufferSourceNode` start times. In
 * the Capacitor iOS shell, the context feeds a `MediaStreamAudioDestinationNode`
 * played by an `HTMLAudioElement` so WebKit renders TTS through the same
 * VoiceProcessingIO unit that captures the microphone. That gives WebKit's
 * acoustic echo canceller the assistant audio as its far-end reference.
 *
 * Playback is gapless because each source is started at the running
 * `playheadTime` cursor — the precise `AudioContext.currentTime` at which the
 * previous buffer finishes — rather than relying on `onended` callbacks, which
 * fire too late to avoid audible gaps between buffers.
 *
 * {@link LiveVoiceAudioPlayer.stop} flushes the queue immediately for
 * barge-in/interrupt: it stops every scheduled source, drops queued chunks, and
 * resets the playhead so the next `enqueue` starts fresh.
 *
 * No audio playback infrastructure exists elsewhere in `clients/web`; this module
 * owns its own `AudioContext` lifecycle.
 */

import { createAudioContext } from "@/domains/chat/voice/audio-context";
import { captureError } from "@/lib/sentry/capture-error";
import { isNativeIOS } from "@/runtime/platform-detection";

/** A single TTS audio frame as delivered by the live-voice channel. */
export interface TtsAudioChunk {
  /**
   * Base64-encoded audio payload. For `audio/pcm` this is raw little-endian
   * 16-bit PCM samples; for container formats it is the encoded container bytes.
   */
  dataBase64: string;
  /**
   * Sample rate of the PCM data in Hz (e.g. 24000). Only meaningful for
   * `audio/pcm` — container formats carry their own rate in the header.
   */
  sampleRate: number;
  /** MIME type of the audio payload (e.g. "audio/pcm", "audio/wav"). */
  mimeType: string;
}

/**
 * Playback progress of the current response's TTS audio.
 *
 * `totalSeconds` is the cumulative duration of every buffer scheduled since the
 * last reset (new response / stop); `playedSeconds` is how much of it has
 * actually sounded, derived from the audio playhead. During a mid-turn silence
 * (queue drained, more speech coming) `playedSeconds === totalSeconds`, so a
 * consumer's cursor holds at the last spoken word rather than resetting — the
 * next audio burst grows `totalSeconds` and the cursor advances again.
 */
export interface LiveVoicePlaybackProgress {
  /** Seconds of scheduled audio already played, in [0, totalSeconds]. */
  playedSeconds: number;
  /** Total seconds of audio scheduled for the current response so far. */
  totalSeconds: number;
}

/**
 * Container MIME types decoded via `AudioContext.decodeAudioData` (which
 * derives sample rate/channels from the container itself). Providers without
 * raw-PCM streaming (e.g. Fish Audio) fall back to one of these.
 */
const CONTAINER_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/opus",
]);

const RAW_PCM_MIME_TYPE = "audio/pcm";

/**
 * Output-amplitude metering tuning for the assistant's own band
 * (see {@link LiveVoiceAudioPlayer.getOutputAmplitude}). Speech RMS sits around
 * 0.05–0.2, so `GAIN` lifts it into a visible range; `SMOOTHING` is the EMA
 * weight toward each new read (~60 Hz from the band's rAF); `DECAY` eases the
 * band back to rest between turns. These are the visual-feel knobs.
 */
/*
 * What must match the capture path (`pcm-capture.ts`) is the *mapped* 0–1
 * range, not the constants: the two meters measure different things. That one
 * is a microphone in a room, this one is the output bus, and their raw RMS
 * ranges are nowhere near each other — so identical gains would be the bug,
 * not the fix. Both feed the same visuals (the room's two bands, the composer
 * bar and the pill), so what a surface tuned against one signal needs is for
 * the other to arrive on the same scale.
 *
 * The original gain of 4 came from an assumed speech RMS of 0.05–0.2. Measured
 * against the rendered band, this path actually sits an order of magnitude
 * lower — around 0.02 — so the assistant's voice arrived at roughly a sixth of
 * the user's for equivalent speech, and its band read as a faint smudge next
 * to a mic band that looked right.
 *
 * The mapping is a saturating exponential rather than `min(1, rms * gain)`.
 * A linear gain large enough to lift a 0.02 RMS into view hard-clips the
 * moment speech gets louder, which trades a band that is too faint for one
 * that is bright but stops responding — the exact pair of complaints this
 * meter has already produced once. `1 - exp(-rms * GAIN)` approaches 1
 * smoothly, so loud passages still separate from each other and the tuning is
 * forgiving of the true RMS range being somewhat different again.
 *
 * Every consumer is decorative — no threshold, VAD, or barge-in decision reads
 * this — so this is a display curve, not signal processing.
 */
const OUTPUT_AMPLITUDE_GAIN = 40;
const OUTPUT_AMPLITUDE_SMOOTHING = 0.5;
const OUTPUT_AMPLITUDE_DECAY = 0.85;

/** Normalize a frame's `mimeType` (strip params, lowercase) for dispatch. */
function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Decode a base64 string into a fresh `ArrayBuffer` of its raw bytes. */
function base64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Minimal structural type for the `AudioContext` surface this player uses.
 * Declared locally so tests can supply a lightweight mock without depending on
 * the full DOM `AudioContext` shape.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNode;
  /**
   * Playback state. A context created outside a user gesture starts
   * `"suspended"` under the browser autoplay policy and outputs nothing until
   * resumed — see {@link LiveVoiceAudioPlayer.prewarm}.
   */
  readonly state: AudioContextState;
  /** Resume a suspended context. Must first be called from a user gesture. */
  resume(): Promise<void>;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  /**
   * Create a MediaStream-backed output bus. Capacitor iOS uses this so WebKit
   * can render TTS through its voice-processing audio unit.
   */
  createMediaStreamDestination?(): MediaStreamAudioDestinationNode;
  /**
   * Create an analyser tapping the output bus for amplitude metering (drives
   * the voice room's responding band and the composer bar's output meter).
   * Optional so lightweight test contexts can omit it; the player then
   * degrades to no metering
   * ({@link LiveVoiceAudioPlayer.getOutputAmplitude} returns 0).
   */
  createAnalyser?(): AnalyserNode;
  /**
   * Create the gain stage the output mute rides on. Optional for the same
   * reason as {@link createAnalyser}: a lightweight test context can omit it,
   * and the player then simply cannot mute its output
   * ({@link LiveVoiceAudioPlayer.setOutputMuted} becomes a no-op).
   */
  createGain?(): GainNode;
  /**
   * Decode an encoded container (wav/mp3/opus) into an `AudioBuffer`, deriving
   * sample rate and channel layout from the container header.
   */
  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>;
  close(): Promise<void>;
}

/** Factory for the `AudioContext`. Overridable in tests. */
export type AudioContextFactory = () => AudioContextLike;

const defaultAudioContextFactory: AudioContextFactory = () =>
  createAudioContext() as unknown as AudioContextLike;

/**
 * `paused` and `readyState` are read for diagnostics only. A route that was
 * accepted at `play()` and later paused itself is indistinguishable from a
 * healthy one unless the element is sampled again while audio is flowing.
 */
type MediaStreamPlaybackElement = Pick<
  HTMLAudioElement,
  "pause" | "play" | "srcObject" | "paused" | "readyState"
>;

type MediaStreamPlaybackElementFactory = () => MediaStreamPlaybackElement;

const defaultMediaStreamPlaybackElementFactory: MediaStreamPlaybackElementFactory =
  () => new Audio();

interface MediaStreamOutputRoute {
  destination: MediaStreamAudioDestinationNode;
  element: MediaStreamPlaybackElement;
}

/**
 * Which sink the scheduled audio ends up in.
 *
 * - `unsupported`: this runtime never attempts the MediaStream route.
 * - `pending`: the route is wanted but no `AudioContext` has been built yet.
 * - `media-stream`: TTS renders through a MediaStream track, which is the only
 *   form WebKit offers its capture unit as echo-cancellation reference audio.
 * - `direct`: `AudioContext.destination`. Playback works and echo cancellation
 *   does not.
 */
export type TtsOutputRoute =
  "unsupported" | "pending" | "media-stream" | "direct";

/** Observable state of the output path, for support bundles. */
export interface TtsOutputRouteDiagnostics {
  route: TtsOutputRoute;
  /** Whether this runtime asks for the MediaStream route at all. */
  mediaStreamRouteRequested: boolean;
  /** Whether the `AudioContext` implementation can build the route. */
  mediaStreamApiAvailable: boolean;
  /** `play()` attempts made on the media element, including restarts. */
  playAttempts: number;
  /** Error name from the most recent rejected `play()`, else `null`. */
  playRejectionName: string | null;
  /** Live element state, sampled at read time. `null` off the route. */
  elementPaused: boolean | null;
  elementReadyState: number | null;
  /** `AudioContext.state`, which reads `suspended` when playback is silently dead. */
  contextState: string | null;
}

/**
 * Decode base64-encoded little-endian 16-bit PCM into normalized Float32
 * samples in the range [-1, 1).
 *
 * Exported for direct unit testing of decode correctness.
 */
export function decodePcm16Base64(dataBase64: string): Float32Array {
  const binary = atob(dataBase64);
  const byteLength = binary.length;
  // Two bytes per 16-bit sample. A trailing odd byte (malformed frame) is
  // ignored rather than throwing, so a single bad frame can't kill the stream.
  const sampleCount = byteLength >> 1;
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    // Reassemble little-endian, then sign-extend the 16-bit value.
    let int16 = (hi << 8) | lo;
    if (int16 >= 0x8000) {
      int16 -= 0x10000;
    }
    // Divide by 32768 so full-scale negative maps to exactly -1.
    samples[i] = int16 / 0x8000;
  }
  return samples;
}

export class LiveVoiceAudioPlayer {
  private readonly createContext: AudioContextFactory;
  private readonly useMediaStreamOutput: boolean;
  private readonly createMediaStreamPlaybackElement: MediaStreamPlaybackElementFactory;
  private context: AudioContextLike | null = null;
  private mediaStreamOutput: MediaStreamOutputRoute | null = null;

  /**
   * Whether the MediaStream route was built for the current context. Distinct
   * from `mediaStreamOutput !== null`, which also goes null on teardown, and
   * from the requested-vs-available distinction the diagnostics report.
   */
  private mediaStreamApiAvailable = false;

  /** `play()` attempts on the media element, including {@link restartOutputRoute}. */
  private playAttempts = 0;

  /**
   * Identifies the current `play()` attempt so a superseded one cannot act on
   * its own rejection. Pausing a media element rejects any `play()` still in
   * flight with `AbortError`, and {@link restartOutputRoute} pauses
   * deliberately, so without this the restart's own abort would be read as a
   * refused route and tear down the path it is re-establishing.
   */
  private playEpoch = 0;

  /** Error name from the most recent rejected `play()`. */
  private playRejectionName: string | null = null;

  /** Sources currently scheduled (playing or pending). */
  private activeSources = new Set<AudioBufferSourceNode>();

  /**
   * Absolute `AudioContext.currentTime` at which the next buffer should begin.
   * Tracks the tail of the scheduled timeline for gapless chaining.
   */
  private playheadTime = 0;

  private playingState = false;

  /**
   * Cumulative duration (seconds) of every buffer scheduled since the last
   * progress reset. Backs {@link getPlaybackProgress}.
   *
   * Deliberately NOT reset in {@link settleIfIdle}: a drain mid-turn (ack →
   * tool run → more speech) zeroes only the playhead, so progress reports
   * `played == total` and a consumer's word cursor holds at the last spoken
   * word instead of snapping back. Reset only on {@link stop} (barge-in
   * flush), {@link resetPlaybackProgress} (new response), and context
   * (re)creation.
   */
  private totalScheduledSeconds = 0;

  /**
   * Analyser tapping the output bus for amplitude metering. Sources connect
   * through it to the destination. Null when the context can't create one
   * (test mock) — {@link getOutputAmplitude} then reports 0.
   */
  private analyser: AnalyserNode | null = null;

  /**
   * Gain stage between the metering tap and the destination, carrying the
   * output mute.
   *
   * Deliberately AFTER the analyser: muting is about the user's ears, not
   * about what is true. The assistant is still speaking while muted, so the
   * room's bands keep showing that it is, and the user can see the reply land
   * rather than watching a dead screen.
   */
  private outputGain: GainNode | null = null;

  /**
   * Whether the assistant's audio is muted. Held on the player rather than
   * only on the node so it survives context (re)creation: a reconnect builds a
   * fresh graph, and the user's mute has to come back with it.
   */
  private outputMuted = false;

  /** Reusable time-domain sample buffer for {@link getOutputAmplitude}. */
  private analyserSamples: Float32Array<ArrayBuffer> | null = null;

  /** EMA-smoothed output amplitude in [0, 1], advanced on each read. */
  private smoothedOutputAmplitude = 0;

  /**
   * Count of container decodes that have started but not yet been scheduled or
   * discarded. The queue isn't drained while any are outstanding: a container
   * frame contributes no scheduled source (and so no `playingState`) until its
   * async `decodeAudioData` resolves, so `waitUntilDrained()` must also wait on
   * these or it would return before the assistant audio is even queued.
   */
  private pendingContainerDecodes = 0;

  /**
   * Generation token bumped on every {@link stop}. A container decode captures
   * the current value when it starts; if it doesn't match after the decode
   * resolves, a flush (barge-in/interrupt) happened meanwhile and the stale
   * buffer is dropped instead of scheduled.
   */
  private generation = 0;

  /** Resolvers for in-flight `waitUntilDrained()` promises. */
  private drainResolvers: Array<() => void> = [];

  /**
   * Tail of the serialized container-decode chain. Container frames decode
   * asynchronously, so they queue behind this promise to schedule strictly in
   * arrival order — only after the previous frame's buffer (and thus its
   * duration) is known can the next reserve its gapless start time.
   */
  private containerDecodeChain: Promise<void> = Promise.resolve();

  constructor(options?: {
    audioContextFactory?: AudioContextFactory;
    useMediaStreamOutput?: boolean;
    mediaStreamPlaybackElementFactory?: MediaStreamPlaybackElementFactory;
  }) {
    this.createContext =
      options?.audioContextFactory ?? defaultAudioContextFactory;
    this.useMediaStreamOutput = options?.useMediaStreamOutput ?? isNativeIOS();
    this.createMediaStreamPlaybackElement =
      options?.mediaStreamPlaybackElementFactory ??
      defaultMediaStreamPlaybackElementFactory;
  }

  /** Whether any audio is scheduled, playing, or still decoding. */
  get isPlaying(): boolean {
    return this.playingState || this.pendingContainerDecodes > 0;
  }

  /**
   * Decode a TTS frame and schedule it to play immediately after whatever is
   * already queued. The decode path is selected on `chunk.mimeType`:
   *
   * - `audio/pcm` — raw 16-bit PCM, decoded synchronously and scheduled now.
   * - container formats (wav/mp3/opus) — decoded asynchronously via
   *   `decodeAudioData`; the start time is reserved up front to keep ordering
   *   and gaplessness intact while decoding.
   * - anything else — skipped with a warning rather than misdecoded as PCM.
   *
   * Empty/malformed PCM chunks (zero samples) are dropped.
   */
  enqueue(chunk: TtsAudioChunk): void {
    const mimeType = normalizeMimeType(chunk.mimeType);

    if (mimeType === RAW_PCM_MIME_TYPE) {
      this.enqueueRawPcm(chunk);
      return;
    }

    if (CONTAINER_MIME_TYPES.has(mimeType)) {
      this.enqueueContainer(chunk, mimeType);
      return;
    }

    console.warn(
      `[LiveVoiceAudioPlayer] skipping tts_audio frame with unsupported mimeType "${chunk.mimeType}"`,
    );
  }

  /** Synchronous raw-PCM fast path. */
  private enqueueRawPcm(chunk: TtsAudioChunk): void {
    const samples = decodePcm16Base64(chunk.dataBase64);
    if (samples.length === 0) {
      return;
    }

    const context = this.ensureContext();

    // Construct the buffer at the frame's own sample rate so the Web Audio
    // engine resamples to the context rate during playback. This handles a
    // mismatch between the incoming frame (e.g. 24 kHz) and a context running
    // at, say, 48 kHz without us having to resample by hand.
    const buffer = context.createBuffer(1, samples.length, chunk.sampleRate);
    buffer.getChannelData(0).set(samples);

    this.scheduleBuffer(context, buffer);
  }

  /**
   * Asynchronous container path (wav/mp3/opus). `decodeAudioData` derives the
   * sample rate and channel layout from the container header, so we ignore
   * `chunk.sampleRate` here.
   *
   * Decodes are serialized through {@link containerDecodeChain} so frames
   * schedule strictly in arrival order: only once a frame is decoded is its
   * buffer duration known, which the next frame needs to chain a gapless start
   * time off the playhead. A decode that completes after a {@link stop} flushes
   * the queue is dropped (generation token mismatch, or the context has been
   * replaced), and a decode failure skips just that frame.
   *
   * The decode is counted in {@link pendingContainerDecodes} while in flight so
   * `waitUntilDrained()`/`isPlaying` treat a not-yet-scheduled frame as still
   * active, and {@link generation} is captured up front so a `stop()` during
   * the decode invalidates it.
   */
  private enqueueContainer(chunk: TtsAudioChunk, mimeType: string): void {
    const context = this.ensureContext();
    const arrayBuffer = base64ToArrayBuffer(chunk.dataBase64);
    const generation = this.generation;
    this.pendingContainerDecodes += 1;

    this.containerDecodeChain = this.containerDecodeChain.then(async () => {
      try {
        let buffer: AudioBuffer;
        try {
          buffer = await context.decodeAudioData(arrayBuffer);
        } catch (err) {
          console.warn(
            `[LiveVoiceAudioPlayer] failed to decode ${mimeType} tts_audio frame; skipping`,
            err,
          );
          return;
        }

        // A stop()/flush happened while decoding (generation bumped) or the
        // context was torn down (close/reuse) — drop the stale buffer.
        if (
          this.generation !== generation ||
          this.context !== context ||
          buffer.length === 0
        ) {
          return;
        }
        this.scheduleBuffer(context, buffer);
      } finally {
        // A stop() between start and resolution already zeroed the counter (and
        // resolved drain); skip the accounting so we don't go negative.
        if (this.generation === generation) {
          this.pendingContainerDecodes -= 1;
          // A decode that skipped (failure/empty) without scheduling can still
          // be the last thing in flight, which drains the queue.
          this.settleIfIdle();
        }
      }
    });
  }

  /** Connect a decoded buffer to the destination and start it gaplessly. */
  private scheduleBuffer(context: AudioContextLike, buffer: AudioBuffer): void {
    const source = context.createBufferSource();
    source.buffer = buffer;

    // Route through the metering analyser when present (so output amplitude can
    // drive the room's responding band), then the mute gain, then the
    // destination. Each stage is optional, so fall through to whichever exists.
    source.connect(
      this.analyser ??
        this.outputGain ??
        this.mediaStreamOutput?.destination ??
        context.destination,
    );

    // Chain start time from the running playhead. Never schedule in the past:
    // if the queue drained the playhead may lag behind currentTime.
    const startAt = Math.max(this.playheadTime, context.currentTime);
    source.start(startAt);
    this.playheadTime = startAt + buffer.duration;
    this.totalScheduledSeconds += buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.handleSourceEnded(source);
    };

    this.playingState = true;
  }

  /**
   * Immediately halt playback and clear the queue (barge-in / interrupt).
   *
   * Stops every scheduled source, drops the playhead, and resolves any pending
   * `waitUntilDrained()` callers — a flushed queue counts as drained.
   *
   * Bumping {@link generation} invalidates any in-flight container decode so a
   * later-resolving `decodeAudioData` is discarded instead of scheduling the
   * interrupted utterance after the flush. Those decodes are also treated as
   * drained immediately (counter zeroed) so `waitUntilDrained()` resolves now
   * rather than waiting on the abandoned decode to settle.
   */
  stop(): void {
    this.generation += 1;
    for (const source of this.activeSources) {
      // Detach the handler first so stop() doesn't re-enter handleSourceEnded
      // mid-iteration as we mutate the set.
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped or never started — safe to ignore.
      }
      source.disconnect();
    }
    this.activeSources.clear();
    this.pendingContainerDecodes = 0;
    this.totalScheduledSeconds = 0;
    // Reset the decode chain so the next response's container frames don't queue
    // behind the abandoned (now generation-invalidated) decode — a slow/stuck
    // `decodeAudioData` from the interrupted utterance must not delay or silence
    // subsequent TTS. The in-flight decode's own `.then` still runs but no-ops on
    // the generation mismatch.
    this.containerDecodeChain = Promise.resolve();
    this.settleIfIdle();
  }

  /**
   * Resolve once the queue has fully drained (all scheduled buffers finished)
   * or after a {@link stop}. Resolves immediately when nothing is playing.
   */
  waitUntilDrained(): Promise<void> {
    if (!this.isPlaying) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /**
   * Release the underlying `AudioContext`. Implicitly stops playback first.
   *
   * Idempotent and safe to call when the context was never created or is
   * already closed: only a context this player owns is closed, and the field is
   * cleared before awaiting so re-entrant/repeat calls are no-ops. The player
   * can be reused afterwards — the next `enqueue` lazily recreates the context.
   */
  async dispose(): Promise<void> {
    this.stop();
    const context = this.context;
    this.context = null;
    this.disposeMediaStreamOutput();
    // The analyser and the mute stage belong to the closed context; drop them
    // (and the analyser's buffer) so a reused player rebuilds its graph against
    // a fresh context rather than writing into detached nodes.
    this.analyser = null;
    this.analyserSamples = null;
    this.outputGain = null;
    this.smoothedOutputAmplitude = 0;
    if (context) {
      await context.close();
    }
  }

  /**
   * Eagerly create and resume the `AudioContext` from within the user gesture
   * that starts a session (the mic-button click). Otherwise the context is
   * created lazily on the first `tts_audio` frame — which arrives seconds later,
   * outside any gesture — so the browser autoplay policy starts it `"suspended"`
   * and it never plays; audio only comes through once the context happens to
   * flip to `"running"`, which is why the first turn(s) drop and later ones
   * work. Safe to call repeatedly; `resume()` is a no-op once running.
   */
  prewarm(): void {
    const context = this.ensureContext();
    if (context.state !== "running") {
      void context.resume();
    }
  }

  private ensureContext(): AudioContextLike {
    if (!this.context) {
      const context = this.createContext();
      this.context = context;
      this.playheadTime = 0;
      this.totalScheduledSeconds = 0;
      const destinationNode = this.createOutputNode(context);
      // Mute stage, closest to the destination so everything upstream (the
      // metering tap included) still sees the real signal.
      let outputNode = destinationNode;
      if (context.createGain) {
        const gain = context.createGain();
        gain.connect(destinationNode);
        gain.gain.value = this.outputMuted ? 0 : 1;
        this.outputGain = gain;
        outputNode = gain;
      }
      // Tap the output bus for amplitude metering when the context supports it.
      // Scheduled sources connect through this analyser to the destination; a
      // context without createAnalyser (test mock) skips metering entirely and
      // getOutputAmplitude() reports 0.
      if (context.createAnalyser) {
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.connect(outputNode);
        this.analyser = analyser;
        this.analyserSamples = new Float32Array(analyser.fftSize);
      }
      void this.startMediaStreamOutput(context);
    }
    return this.context;
  }

  private createOutputNode(context: AudioContextLike): AudioNode {
    // WebKit only supplies default-device MediaStream-track playback to its
    // VoiceProcessingIO capture unit as far-end echo-cancellation audio:
    // https://github.com/WebKit/WebKit/blob/41daa01748411a95855d8b6a0f0ffbd54f729a08/Source/WebKit/GPUProcess/webrtc/RemoteAudioMediaStreamTrackRendererInternalUnitManager.cpp#L228-L292
    this.mediaStreamApiAvailable =
      context.createMediaStreamDestination !== undefined;
    if (!this.useMediaStreamOutput || !context.createMediaStreamDestination) {
      return context.destination;
    }

    const destination = context.createMediaStreamDestination();
    const element = this.createMediaStreamPlaybackElement();
    element.srcObject = destination.stream;
    this.mediaStreamOutput = { destination, element };
    return destination;
  }

  /**
   * Begin (or resume) rendering the MediaStream track.
   *
   * Resolves once the attempt has settled, including any fallback the rejection
   * triggers, so a caller can read the resulting route rather than whatever it
   * happens to be mid-flight. Never rejects.
   */
  private startMediaStreamOutput(context: AudioContextLike): Promise<void> {
    const route = this.mediaStreamOutput;
    if (!route) {
      return Promise.resolve();
    }

    this.playAttempts += 1;
    const epoch = ++this.playEpoch;
    return route.element.play().catch((error: unknown) => {
      // A newer attempt has taken over, so this rejection is the pause() that
      // started it and says nothing about whether playback is allowed. Recording
      // it would also report a refusal the route never suffered.
      if (this.playEpoch !== epoch) {
        return;
      }
      this.playRejectionName =
        error instanceof Error ? error.name : "UnknownError";
      if (this.context !== context || this.mediaStreamOutput !== route) {
        return;
      }

      this.disposeMediaStreamOutput();
      this.connectOutputTail(context.destination);
      captureError(error, {
        context: "live_voice_ios_media_stream_output",
      });
    });
  }

  /**
   * Point the tail of the graph at `destination`, preserving whichever optional
   * stages exist. Sources feed the analyser, the analyser feeds the mute stage,
   * and the mute stage feeds the sink, so the mute survives every rewiring: a
   * silenced assistant must not start playing aloud because its output route
   * changed underneath it.
   */
  private connectOutputTail(destination: AudioNode): void {
    if (this.outputGain) {
      this.outputGain.disconnect();
      this.outputGain.connect(destination);
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser.connect(this.outputGain ?? destination);
    }
  }

  /**
   * Re-render the MediaStream track now that microphone capture is running.
   *
   * WebKit renders a MediaStream track through whichever capture unit is active
   * when the renderer starts, and the echo reference is a property of that
   * unit. The player is deliberately prewarmed from the user gesture that
   * begins a session, which is *before* `getUserMedia` has created any capture
   * unit, so the renderer can come up bound to a plain output unit that never
   * acquires an echo reference. Restarting it once the mic is live rebinds it
   * against the voice-processing unit.
   *
   * It is also the second chance the gesture-less start paths need, which is
   * why a route that has already fallen back is rebuilt here rather than left
   * alone. A session begun from Siri, the Action Button, or a Live Activity tap
   * has no activation to borrow, so its prewarm `play()` is refused and the
   * fallback tears the route down. That is precisely the session that most
   * needs another attempt: by now the page holds a live `getUserMedia` stream,
   * which is grounds for playing a MediaStream element that an unactivated page
   * could not. Skipping it would strand exactly those sessions on the direct
   * path forever.
   *
   * Safe to call at any point: it no-ops off the route entirely, and it runs
   * while the queue is silent, so the pause is inaudible. Never throws; a
   * refused retry degrades exactly like a refused initial start.
   *
   * Resolves once the attempt has settled, fallback included. Anything that
   * reports which route a session ended up on has to await this, or it can
   * observe a route that the pending rejection is about to tear down.
   */
  restartOutputRoute(): Promise<void> {
    const context = this.context;
    if (!context) {
      return Promise.resolve();
    }

    const route = this.mediaStreamOutput;
    if (route) {
      route.element.pause();
      return this.startMediaStreamOutput(context);
    }

    if (!this.useMediaStreamOutput || !context.createMediaStreamDestination) {
      return Promise.resolve();
    }
    const destination = this.createOutputNode(context);
    this.connectOutputTail(destination);
    return this.startMediaStreamOutput(context);
  }

  /**
   * Snapshot the output path for a support bundle. Reads live element state, so
   * a route that was accepted and later paused itself reports honestly.
   */
  getOutputRouteDiagnostics(): TtsOutputRouteDiagnostics {
    const route = this.mediaStreamOutput;
    return {
      route: !this.useMediaStreamOutput
        ? "unsupported"
        : route
          ? "media-stream"
          : this.context === null
            ? "pending"
            : "direct",
      mediaStreamRouteRequested: this.useMediaStreamOutput,
      mediaStreamApiAvailable: this.mediaStreamApiAvailable,
      playAttempts: this.playAttempts,
      playRejectionName: this.playRejectionName,
      elementPaused: route?.element.paused ?? null,
      elementReadyState: route?.element.readyState ?? null,
      contextState: this.context?.state ?? null,
    };
  }

  private disposeMediaStreamOutput(): void {
    const route = this.mediaStreamOutput;
    this.mediaStreamOutput = null;
    if (!route) {
      return;
    }

    route.element.pause();
    route.element.srcObject = null;
    for (const track of route.destination.stream.getTracks()) {
      track.stop();
    }
  }

  /**
   * Mute or unmute the assistant's audio without touching the session.
   *
   * Distinct from stopping a reply: the assistant keeps talking, the turn keeps
   * running, and the transcript keeps filling. Only the sound stops, so
   * unmuting mid-reply drops the user back into it wherever it has got to.
   *
   * The flag is remembered even with no context yet (a mute set before the
   * first reply) and re-applied to every graph this player builds, so a
   * reconnect does not un-mute the assistant behind the user's back. A context
   * without `createGain` (test mock) has no stage to ride, and this no-ops.
   */
  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted;
    if (this.outputGain) {
      this.outputGain.gain.value = muted ? 0 : 1;
    }
  }

  /** Whether the assistant's audio is currently muted. */
  isOutputMuted(): boolean {
    return this.outputMuted;
  }

  /**
   * Current smoothed output amplitude in [0, 1], read from the output-bus
   * analyser — the RMS of the audio the assistant is speaking right now. Drives
   * the voice room's `responding` band, and the output meters on the composer
   * bar and the title-bar pill. It has to come off the output bus: the mic
   * amplitude behind `listening` is near-silent while the assistant speaks.
   *
   * Polled ~60 Hz from the band's rAF loop: it EMA-smooths so the band
   * breathes rather than jitters, and decays toward rest when nothing is
   * playing. Returns 0 with no analyser (test mock).
   */
  getOutputAmplitude(): number {
    const analyser = this.analyser;
    const samples = this.analyserSamples;
    if (!analyser || !samples) {
      return 0;
    }

    if (!this.playingState) {
      // Nothing scheduled: ease back to rest so the band settles between
      // turns instead of holding the last speaking level.
      this.smoothedOutputAmplitude *= OUTPUT_AMPLITUDE_DECAY;
      return this.smoothedOutputAmplitude;
    }

    const scaled = this.readOutputLevel();
    this.smoothedOutputAmplitude =
      OUTPUT_AMPLITUDE_SMOOTHING * scaled +
      (1 - OUTPUT_AMPLITUDE_SMOOTHING) * this.smoothedOutputAmplitude;
    return this.smoothedOutputAmplitude;
  }

  /**
   * Instantaneous mapped output level in [0, 1], leaving the display smoothing
   * untouched. Returns 0 when nothing is scheduled or there is no analyser.
   *
   * Separate from {@link getOutputAmplitude} because that one is a stateful EMA
   * tuned for a single ~60 Hz rAF consumer: every call advances its smoothing,
   * so a second caller on a different cadence would both perturb what the
   * band displays and make its own readings depend on whether the band happens
   * to be mounted. A measurement has to be independent of who else is
   * looking.
   */
  readOutputLevel(): number {
    const analyser = this.analyser;
    const samples = this.analyserSamples;
    if (!analyser || !samples || !this.playingState) {
      return 0;
    }

    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    // Saturating rather than clipping, per the constant's note above.
    return 1 - Math.exp(-rms * OUTPUT_AMPLITUDE_GAIN);
  }

  /**
   * Playback progress of the current response's TTS audio, or `null` when
   * nothing has been scheduled since the last reset (no context yet, fresh
   * response, or post-stop/dispose).
   *
   * Played time is derived from the playhead rather than accumulated:
   * `remaining = playheadTime - currentTime` is the unplayed tail of the
   * scheduled timeline, so silent gaps between bursts never inflate played
   * time, and after a drain (`playheadTime` zeroed) progress reports
   * `played == total`. Side-effect-free: reading never advances state.
   */
  getPlaybackProgress(): LiveVoicePlaybackProgress | null {
    if (this.context === null || this.totalScheduledSeconds === 0) {
      return null;
    }
    const remaining = Math.max(0, this.playheadTime - this.context.currentTime);
    const played = Math.min(
      this.totalScheduledSeconds,
      Math.max(0, this.totalScheduledSeconds - remaining),
    );
    return { playedSeconds: played, totalSeconds: this.totalScheduledSeconds };
  }

  /**
   * Zero the playback-progress accumulator for a new response. Called by the
   * controller at the start of each response, paired with the transcript
   * clear, so the word cursor starts fresh with the new caption.
   */
  resetPlaybackProgress(): void {
    this.totalScheduledSeconds = 0;
  }

  private handleSourceEnded(source: AudioBufferSourceNode): void {
    if (!this.activeSources.delete(source)) {
      return;
    }
    source.disconnect();
    this.settleIfIdle();
  }

  /**
   * Mark playback finished and resolve drain waiters once nothing is left to
   * play — neither a scheduled source nor an in-flight container decode that
   * could still schedule one. Called whenever either count reaches zero.
   */
  private settleIfIdle(): void {
    if (this.activeSources.size > 0 || this.pendingContainerDecodes > 0) {
      return;
    }
    this.playheadTime = 0;
    this.playingState = false;
    this.resolveDrain();
  }

  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
