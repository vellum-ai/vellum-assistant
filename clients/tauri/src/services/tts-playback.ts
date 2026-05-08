/**
 * Streaming TTS playback for the HUD. The daemon sends `tts_audio`
 * frames (base64-encoded PCM or MP3 chunks) as the LLM streams; we
 * decode each chunk and queue it onto an `AudioContext` so playback
 * starts before the full utterance is synthesized.
 *
 * The implementation is deliberately conservative: PCM-int16 chunks
 * are decoded inline; non-PCM payloads (e.g. MP3 from the system-TTS
 * fallback) are passed through `decodeAudioData` which is async but
 * still gap-free if the chunks arrive faster than realtime.
 */

export interface TtsChunk {
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

export class TtsPlayback {
  private context: AudioContext | null = null;
  private nextStartTime = 0;

  enqueue(chunk: TtsChunk): void {
    const context = this.ensureContext();
    void this.scheduleChunk(context, chunk);
  }

  async stop(): Promise<void> {
    this.nextStartTime = 0;
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
    }
    return this.context;
  }

  private async scheduleChunk(
    context: AudioContext,
    chunk: TtsChunk,
  ): Promise<void> {
    try {
      const buffer = await this.decodeChunk(context, chunk);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(this.nextStartTime, context.currentTime);
      source.start(startAt);
      this.nextStartTime = startAt + buffer.duration;
    } catch {
      // Swallow decode errors — the live-voice pipeline emits a
      // `tts_done` either way and the HUD will fall back to text.
    }
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
