/**
 * Streamed TTS playback queue for the live-voice channel.
 *
 * The server streams text-to-speech audio as `tts_audio` frames carrying
 * base64-encoded little-endian 16-bit PCM (default 24 kHz mono, but each frame
 * advertises its own `sampleRate`/`mimeType`). {@link LiveVoiceAudioPlayer}
 * decodes each chunk (base64 → `Int16Array` → `Float32Array`) and schedules
 * gapless sequential playback through a Web Audio `AudioContext` by chaining
 * `AudioBufferSourceNode` start times.
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
 * No audio playback infrastructure exists elsewhere in `apps/web`; this module
 * owns its own `AudioContext` lifecycle.
 */

/** A single TTS audio frame as delivered by the live-voice channel. */
export interface TtsAudioChunk {
  /** Base64-encoded little-endian 16-bit PCM samples. */
  dataBase64: string;
  /** Sample rate of the PCM data in Hz (e.g. 24000). */
  sampleRate: number;
  /** MIME type of the audio payload (e.g. "audio/pcm"). */
  mimeType: string;
}

/** Observer notified whenever `isPlaying` or `queuedCount` changes. */
export type PlaybackObserver = (state: {
  isPlaying: boolean;
  queuedCount: number;
}) => void;

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
  close(): Promise<void>;
}

/** Factory for the `AudioContext`. Overridable in tests. */
export type AudioContextFactory = () => AudioContextLike;

const defaultAudioContextFactory: AudioContextFactory = () => {
  // Safari only exposes the prefixed constructor, matching the fallback used
  // by SoundManager and use-push-to-talk elsewhere in the voice domain.
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return new Ctor() as unknown as AudioContextLike;
};

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

  private observers = new Set<PlaybackObserver>();

  private playingState = false;
  private queuedCountState = 0;

  /** Resolvers for in-flight `waitUntilDrained()` promises. */
  private drainResolvers: Array<() => void> = [];

  constructor(options?: { audioContextFactory?: AudioContextFactory }) {
    this.createContext = options?.audioContextFactory ?? defaultAudioContextFactory;
  }

  /** Whether any audio is currently scheduled or playing. */
  get isPlaying(): boolean {
    return this.playingState;
  }

  /** Number of buffers currently scheduled (playing or pending). */
  get queuedCount(): number {
    return this.queuedCountState;
  }

  /**
   * Subscribe to playback-state changes. Returns an unsubscribe function.
   * The observer is invoked immediately with the current state.
   */
  subscribe(observer: PlaybackObserver): () => void {
    this.observers.add(observer);
    observer({ isPlaying: this.playingState, queuedCount: this.queuedCountState });
    return () => {
      this.observers.delete(observer);
    };
  }

  /**
   * Decode a PCM chunk and schedule it to play immediately after whatever is
   * already queued. Empty/malformed chunks (zero samples) are dropped.
   */
  enqueue(chunk: TtsAudioChunk): void {
    const samples = decodePcm16Base64(chunk.dataBase64);
    if (samples.length === 0) return;

    const context = this.ensureContext();

    // Construct the buffer at the frame's own sample rate so the Web Audio
    // engine resamples to the context rate during playback. This handles a
    // mismatch between the incoming frame (e.g. 24 kHz) and a context running
    // at, say, 48 kHz without us having to resample by hand.
    const buffer = context.createBuffer(1, samples.length, chunk.sampleRate);
    buffer.getChannelData(0).set(samples);

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

    this.setState(true, this.activeSources.size);
  }

  /**
   * Immediately halt playback and clear the queue (barge-in / interrupt).
   *
   * Stops every scheduled source, drops the playhead, and resolves any pending
   * `waitUntilDrained()` callers — a flushed queue counts as drained.
   */
  stop(): void {
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
    this.playheadTime = 0;
    this.setState(false, 0);
    this.resolveDrain();
  }

  /**
   * Resolve once the queue has fully drained (all scheduled buffers finished)
   * or after a {@link stop}. Resolves immediately when nothing is playing.
   */
  waitUntilDrained(): Promise<void> {
    if (!this.playingState) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /**
   * Release the underlying `AudioContext`. Implicitly stops playback first.
   * The player can be reused afterwards — the next `enqueue` lazily recreates
   * the context.
   */
  async close(): Promise<void> {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context) await context.close();
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
    if (this.activeSources.size === 0) {
      this.playheadTime = 0;
      this.setState(false, 0);
      this.resolveDrain();
    } else {
      this.setState(true, this.activeSources.size);
    }
  }

  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private setState(isPlaying: boolean, queuedCount: number): void {
    if (isPlaying === this.playingState && queuedCount === this.queuedCountState) {
      return;
    }
    this.playingState = isPlaying;
    this.queuedCountState = queuedCount;
    for (const observer of this.observers) {
      observer({ isPlaying, queuedCount });
    }
  }
}
