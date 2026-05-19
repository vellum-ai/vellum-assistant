/**
 * Streaming TTS playback for the HUD. The daemon sends `tts_audio`
 * frames (base64-encoded PCM or MP3 chunks) as the LLM streams; we
 * decode each chunk and queue it onto an `AudioContext` so playback
 * starts before the full utterance is synthesized.
 *
 * Cadence model: xAI's streaming session is text-delta-driven. The
 * provider synthesizes audio for each LLM text chunk and sends it back
 * as it produces it — so audio frames don't arrive at a steady realtime
 * rate, they bunch around LLM bursts and pauses. Without lookahead the
 * audio engine drains the scheduled tail during a pause and the user
 * hears mid-word stuttering.
 *
 * The strategy:
 *   1. On every transition into "playing", first accumulate at least
 *      `STARTUP_BUFFER_S` of decoded audio (or hit the time-budget so
 *      short replies still start promptly), then flush it back-to-back.
 *   2. While playing, watch the headroom `nextStartTime - currentTime`.
 *      If it ever falls below `UNDERRUN_THRESHOLD_S`, drop back to
 *      buffer-up mode so the next batch of chunks rebuilds a cushion
 *      before audible playback resumes — that's a single short pause
 *      instead of repeated stutters.
 *
 * Trade-off: ~300-350ms of added latency on the first audio of a turn
 * (and again on any underrun recovery) in exchange for gap-free
 * playback. LLM thinking time before TTS starts dwarfs this, so it's
 * imperceptible at the conversation level.
 */

export interface TtsChunk {
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

const STARTUP_BUFFER_S = 0.35;
const STARTUP_BUFFER_TIMEOUT_MS = 350;
const MIN_LEAD_S = 0.02;
const UNDERRUN_THRESHOLD_S = 0.05;

export class TtsPlayback {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private pendingBuffers: AudioBuffer[] = [];
  private pendingDurationS = 0;
  private buffering = true;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private decodeChain: Promise<void> = Promise.resolve();

  enqueue(chunk: TtsChunk): void {
    const context = this.ensureContext();
    // Serialize decodes so audio always plays in arrival order even
    // when the async `decodeAudioData` path takes longer than the next
    // chunk's synchronous PCM decode.
    this.decodeChain = this.decodeChain
      .catch(() => {})
      .then(() => this.scheduleChunk(context, chunk));
  }

  async stop(): Promise<void> {
    this.nextStartTime = 0;
    this.pendingBuffers = [];
    this.pendingDurationS = 0;
    this.buffering = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (!this.context) return;
    try {
      await this.context.close();
    } catch {
      // already closed
    }
    this.context = null;
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.nextStartTime = this.context.currentTime;
      this.buffering = true;
      this.pendingDurationS = 0;
      this.pendingBuffers = [];
    }
    // AudioContext often starts suspended until the first user gesture;
    // resume eagerly so scheduled chunks actually play.
    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
    return this.context;
  }

  private async scheduleChunk(
    context: AudioContext,
    chunk: TtsChunk,
  ): Promise<void> {
    let buffer: AudioBuffer;
    try {
      buffer = await this.decodeChunk(context, chunk);
    } catch {
      // Swallow decode errors — the live-voice pipeline emits a
      // `tts_done` either way and the HUD will fall back to text.
      return;
    }

    // Re-enter buffering if the playhead is about to catch up. This
    // prevents the engine from playing the tail of the previous chunk,
    // then silence, then the next chunk — i.e. the actual stutter.
    if (
      !this.buffering &&
      this.nextStartTime - context.currentTime < UNDERRUN_THRESHOLD_S
    ) {
      this.buffering = true;
      this.pendingDurationS = 0;
      this.armStartupTimer(context);
    }

    if (!this.buffering) {
      this.scheduleDecodedBuffer(context, buffer);
      return;
    }

    this.pendingBuffers.push(buffer);
    this.pendingDurationS += buffer.duration;

    if (this.pendingBuffers.length === 1 && !this.startupTimer) {
      this.armStartupTimer(context);
    }

    if (this.pendingDurationS >= STARTUP_BUFFER_S) {
      this.flushPending(context);
    }
  }

  private armStartupTimer(context: AudioContext): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.buffering && this.pendingBuffers.length > 0) {
        this.flushPending(context);
      }
    }, STARTUP_BUFFER_TIMEOUT_MS);
  }

  private flushPending(context: AudioContext): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.buffering = false;
    // After (re-)entering play mode we may already be slightly behind
    // the originally-tracked tail, so clamp the next scheduled chunk
    // to a safe distance ahead of the playhead.
    this.nextStartTime = Math.max(
      this.nextStartTime,
      context.currentTime + MIN_LEAD_S,
    );
    for (const buffer of this.pendingBuffers) {
      this.scheduleDecodedBuffer(context, buffer);
    }
    this.pendingBuffers = [];
    this.pendingDurationS = 0;
  }

  private scheduleDecodedBuffer(
    context: AudioContext,
    buffer: AudioBuffer,
  ): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(
      this.nextStartTime,
      context.currentTime + MIN_LEAD_S,
    );
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  private async decodeChunk(
    context: AudioContext,
    chunk: TtsChunk,
  ): Promise<AudioBuffer> {
    const bytes = base64ToBytes(chunk.dataBase64);

    if (
      chunk.mimeType === "audio/pcm" ||
      chunk.mimeType === "audio/L16" ||
      chunk.mimeType === "audio/wav"
    ) {
      return decodeInt16Pcm(context, bytes, chunk.sampleRate);
    }

    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return await context.decodeAudioData(copy);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeInt16Pcm(
  context: AudioContext,
  bytes: Uint8Array,
  sampleRate: number,
): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const buffer = context.createBuffer(1, sampleCount, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true);
    channel[i] = sample / 0x8000;
  }
  return buffer;
}
