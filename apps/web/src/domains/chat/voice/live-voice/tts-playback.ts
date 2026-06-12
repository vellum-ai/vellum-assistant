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
 * {@link LiveVoiceAudioPlayer.stop} flushes the queue for barge-in/interrupt:
 * it fades the master gain to silence over {@link STOP_FADE_OUT_SECONDS} (a
 * hard cut produces an audible click), schedules every source to halt at the
 * end of the fade, drops queued chunks, and resets the playhead so the next
 * `enqueue` starts fresh.
 *
 * All sources play through a single master {@link GainNodeLike} which also
 * carries the user's TTS volume/mute preference
 * ({@link LiveVoiceAudioPlayer.setVolume} / {@link LiveVoiceAudioPlayer.setMuted}).
 *
 * No audio playback infrastructure exists elsewhere in `apps/web`; this module
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

/** Clamp a volume preference into the valid [0, 1] gain range. */
function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
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
 * Duration of the gain ramp applied on {@link LiveVoiceAudioPlayer.stop}. An
 * immediate cut produces an audible click; 20ms is short enough that an
 * interrupt still feels instant.
 */
export const STOP_FADE_OUT_SECONDS = 0.02;

/** Minimal structural type for the `AudioParam` surface the player drives. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

/** Minimal structural type for the master `GainNode`. */
export interface GainNodeLike {
  readonly gain: AudioParamLike;
  connect(destination: AudioNode): unknown;
  disconnect(): unknown;
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
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNodeLike;
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

  /** Master gain between every source and the destination (volume/mute/fade). */
  private gainNode: GainNodeLike | null = null;

  /** User TTS volume preference in [0, 1]; applied through the master gain. */
  private volume: number;

  /** User TTS mute preference; mutes the master gain without pausing playback. */
  private muted: boolean;

  /**
   * Set when {@link stop} ramped the gain to silence; the next scheduled
   * buffer restores the gain to the user's level before starting.
   */
  private fadePending = false;

  /**
   * Wall-clock time (ms) at which the stop-fade finishes. {@link dispose}
   * waits this out before closing the context so an interrupt's fade is
   * actually heard instead of being cut by the context teardown.
   */
  private fadeEndsAtMs = 0;

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

  constructor(options?: {
    audioContextFactory?: AudioContextFactory;
    /** Initial TTS volume in [0, 1]. Defaults to full volume. */
    volume?: number;
    /** Initial mute state. Defaults to unmuted. */
    muted?: boolean;
  }) {
    this.createContext = options?.audioContextFactory ?? defaultAudioContextFactory;
    this.volume = clampVolume(options?.volume ?? 1);
    this.muted = options?.muted ?? false;
  }

  /** Whether any audio is scheduled, playing, or still decoding. */
  get isPlaying(): boolean {
    return this.playingState || this.pendingContainerDecodes > 0;
  }

  /** Gain the master node should sit at outside of a stop-fade. */
  private get effectiveGain(): number {
    return this.muted ? 0 : this.volume;
  }

  /** Set the TTS volume (clamped to [0, 1]); applies live to playing audio. */
  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    this.applyGain();
  }

  /** Mute/unmute TTS output without pausing the scheduled timeline. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /**
   * Snap the master gain to the user's level. A pending stop-fade is left
   * untouched — cancelling its ramp would un-silence sources that are about
   * to halt — the new level lands when the next buffer is scheduled.
   */
  private applyGain(): void {
    if (!this.context || !this.gainNode || this.fadePending) return;
    const now = this.context.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.effectiveGain, now);
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

  /** Connect a decoded buffer through the master gain and start it gaplessly. */
  private scheduleBuffer(context: AudioContextLike, buffer: AudioBuffer): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode as unknown as AudioNode);

    // A previous stop() faded the gain to silence; bring it back to the
    // user's level for the new utterance.
    if (this.fadePending) {
      this.fadePending = false;
      this.applyGain();
    }

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
   * Halt playback and clear the queue (barge-in / interrupt).
   *
   * The master gain ramps to silence over {@link STOP_FADE_OUT_SECONDS} and
   * every scheduled source is halted at the end of the ramp — an immediate
   * `stop()`/`disconnect()` produces an audible click. Sources whose start
   * time lies beyond the fade window simply never sound. The queue is
   * dropped, the playhead reset, and any pending `waitUntilDrained()` callers
   * resolve — a flushed queue counts as drained.
   *
   * Bumping {@link generation} invalidates any in-flight container decode so a
   * later-resolving `decodeAudioData` is discarded instead of scheduling the
   * interrupted utterance after the flush. Those decodes are also treated as
   * drained immediately (counter zeroed) so `waitUntilDrained()` resolves now
   * rather than waiting on the abandoned decode to settle.
   */
  stop(): void {
    this.generation += 1;
    const context = this.context;
    if (context && this.gainNode && this.activeSources.size > 0) {
      const now = context.currentTime;
      const stopAt = now + STOP_FADE_OUT_SECONDS;
      const gain = this.gainNode.gain;
      // Pin the ramp's start value first — linearRampToValueAtTime ramps from
      // the previous scheduled event, which may be far in the past.
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(this.effectiveGain, now);
      gain.linearRampToValueAtTime(0, stopAt);
      this.fadePending = true;
      this.fadeEndsAtMs = Date.now() + STOP_FADE_OUT_SECONDS * 1000;
      for (const source of this.activeSources) {
        // Detach the handler first so stop() doesn't re-enter
        // handleSourceEnded mid-iteration as we mutate the set.
        source.onended = null;
        try {
          source.stop(stopAt);
        } catch {
          // Already stopped or never started — safe to ignore.
        }
      }
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
   * If a stop-fade is still in flight, closing is deferred until it finishes —
   * closing the context hard-cuts output, which is exactly the click the fade
   * exists to avoid.
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
    this.gainNode = null;
    this.fadePending = false;
    if (!context) return;
    const fadeRemainingMs = this.fadeEndsAtMs - Date.now();
    if (fadeRemainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fadeRemainingMs));
    }
    await context.close();
  }

  private ensureContext(): AudioContextLike {
    if (!this.context) {
      this.context = this.createContext();
      this.playheadTime = 0;
      this.fadePending = false;
      const gainNode = this.context.createGain();
      gainNode.gain.value = this.effectiveGain;
      gainNode.connect(this.context.destination);
      this.gainNode = gainNode;
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
