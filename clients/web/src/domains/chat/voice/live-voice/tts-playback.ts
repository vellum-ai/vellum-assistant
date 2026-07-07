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
 * Web Audio `AudioContext` by chaining `AudioBufferSourceNode` start times.
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
    if (int16 >= 0x8000) int16 -= 0x10000;
    // Divide by 32768 so full-scale negative maps to exactly -1.
    samples[i] = int16 / 0x8000;
  }
  return samples;
}

export class LiveVoiceAudioPlayer {
  private readonly createContext: AudioContextFactory;
  private context: AudioContextLike | null = null;

  /** Sources currently scheduled (playing or pending). */
  private activeSources = new Set<AudioBufferSourceNode>();

  /**
   * Absolute `AudioContext.currentTime` at which the next buffer should begin.
   * Tracks the tail of the scheduled timeline for gapless chaining.
   */
  private playheadTime = 0;

  private playingState = false;

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

  constructor(options?: { audioContextFactory?: AudioContextFactory }) {
    this.createContext = options?.audioContextFactory ?? defaultAudioContextFactory;
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
    if (samples.length === 0) return;

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
    source.connect(context.destination);

    // Chain start time from the running playhead. Never schedule in the past:
    // if the queue drained the playhead may lag behind currentTime.
    const startAt = Math.max(this.playheadTime, context.currentTime);
    source.start(startAt);
    this.playheadTime = startAt + buffer.duration;

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
    if (!this.isPlaying) return Promise.resolve();
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
    if (context) await context.close();
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
    if (context.state !== "running") void context.resume();
  }

  private ensureContext(): AudioContextLike {
    if (!this.context) {
      this.context = this.createContext();
      this.playheadTime = 0;
    }
    return this.context;
  }

  private handleSourceEnded(source: AudioBufferSourceNode): void {
    if (!this.activeSources.delete(source)) return;
    source.disconnect();
    this.settleIfIdle();
  }

  /**
   * Mark playback finished and resolve drain waiters once nothing is left to
   * play — neither a scheduled source nor an in-flight container decode that
   * could still schedule one. Called whenever either count reaches zero.
   */
  private settleIfIdle(): void {
    if (this.activeSources.size > 0 || this.pendingContainerDecodes > 0) return;
    this.playheadTime = 0;
    this.playingState = false;
    this.resolveDrain();
  }

  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
