/**
 * Streaming PCM microphone capture for the real-time live-voice channel.
 *
 * Distinct from the one-shot dictation capture in
 * `domains/chat/components/voice-input-button.tsx`, which uses `MediaRecorder`
 * to produce compressed blobs. Live voice needs raw, low-latency PCM, so this
 * pipes `getUserMedia` audio through an `AudioWorklet` that downsamples to
 * 16 kHz mono and emits signed 16-bit little-endian PCM chunks.
 *
 * Each chunk is delivered via `onChunk(buf)` as a transferred `ArrayBuffer`.
 * An RMS `amplitude` in [0, 1] is also surfaced for UI / barge-in detection,
 * reusing the smoothing constants from `domains/voice/use-audio-amplitude.ts`.
 *
 * The capture is permission-agnostic: it requests `getUserMedia` directly and
 * surfaces a denial as a typed `LiveVoiceCaptureResult` rather than throwing.
 * Per `apps/web/AGENTS.md` / `docs/CAPACITOR.md` § OS permission requests,
 * callers own any pre-permission UX (and must not render a dismissible
 * pre-prompt on Capacitor iOS).
 */

/** Output audio contract — must match the runtime `start` frame. */
export const LIVE_VOICE_AUDIO_FORMAT = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
} as const;

// Matches `use-audio-amplitude.ts` (and the macOS AudioEngineController):
// 0.5/0.5 EMA, scaled by 14 and clamped to 1.0.
const AMPLITUDE_SMOOTHING = 0.5;
const AMPLITUDE_SCALE = 14.0;

const WORKLET_PROCESSOR_NAME = "pcm-downsample";

/**
 * Converts a Float32 mono buffer (sampled at `inputRate`) to 16 kHz signed
 * 16-bit PCM via linear decimation. Shared by the AudioWorklet processor and
 * its tests so the conversion math has a single, directly-testable home.
 */
export function downsampleToInt16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / LIVE_VOICE_AUDIO_FORMAT.sampleRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const pcm = new Int16Array(outLength);
  let pos = 0;
  for (let i = 0; i < outLength; i++) {
    const sample = input[Math.floor(pos)] ?? 0;
    // Clamp to [-1, 1] then scale to the signed 16-bit range. The asymmetric
    // 0x8000 / 0x7fff factors map -1.0 -> -32768 and +1.0 -> +32767.
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    pos += ratio;
  }
  return pcm;
}
// Vite rewrites this into a bundled worklet asset URL at build time, mirroring
// the `new URL(..., import.meta.url)` worker pattern.
// https://vite.dev/guide/assets#new-url-url-import-meta-url
const WORKLET_MODULE_URL = new URL("./pcm-downsample-worklet.ts", import.meta.url);

/** Reason a capture failed to start, mapped from `getUserMedia` DOMExceptions. */
export type LiveVoiceCaptureError =
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-in-use"
  | "aborted"
  | "unknown";

export type LiveVoiceCaptureResult =
  | { ok: true }
  | { ok: false; error: LiveVoiceCaptureError; cause?: unknown };

export interface LiveVoiceAudioCaptureOptions {
  /** Receives each 16 kHz mono Int16 LE PCM chunk as a transferred buffer. */
  onChunk: (buf: ArrayBuffer) => void;
  /** Receives the smoothed RMS amplitude in [0, 1] for UI / barge-in. */
  onAmplitude?: (amplitude: number) => void;
}

/**
 * Whether streaming PCM capture can run in this environment.
 *
 * Pure feature detection per `docs/CAPACITOR.md` § Platform short-circuits —
 * Capacitor iOS is a WKWebView that ships these W3C media APIs, so there is no
 * platform branch here. Returns false only when an API is genuinely absent.
 */
export function isSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== "undefined" &&
    // AudioWorklet is present on a constructed context's `audioWorklet`.
    "audioWorklet" in AudioContext.prototype
  );
}

function classifyError(cause: unknown): LiveVoiceCaptureError {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "permission-denied";
      case "NotFoundError":
      case "OverconstrainedError":
        return "no-device";
      case "NotReadableError":
        return "device-in-use";
      case "AbortError":
        return "aborted";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

/**
 * Streaming PCM capture instance. Construct once, then `start()` to open the
 * mic, `stop()` to release the mic + audio graph (re-`start()`able), and
 * `shutdown()` to permanently dispose.
 */
export class LiveVoiceAudioCapture {
  private readonly onChunk: (buf: ArrayBuffer) => void;
  private readonly onAmplitude?: (amplitude: number) => void;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private smoothedAmplitude = 0;
  private disposed = false;

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onAmplitude = options.onAmplitude;
  }

  /**
   * Requests mic access, builds the audio graph, and begins emitting chunks.
   * Permission/device failures are returned as a typed result — they never
   * throw. Calling `start()` while already running is a no-op success.
   */
  async start(): Promise<LiveVoiceCaptureResult> {
    if (this.disposed) return { ok: false, error: "unsupported" };
    if (this.context) return { ok: true };
    if (!isSupported()) return { ok: false, error: "unsupported" };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      return { ok: false, error: classifyError(cause), cause };
    }

    // A concurrent shutdown()/stop() may have raced the await above.
    if (this.disposed) {
      stopTracks(stream);
      return { ok: false, error: "aborted" };
    }
    this.stream = stream;

    try {
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule(WORKLET_MODULE_URL.href);

      if (this.disposed) {
        await this.teardown();
        return { ok: false, error: "aborted" };
      }

      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: LIVE_VOICE_AUDIO_FORMAT.channels,
      });
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const buf = event.data;
        this.emitAmplitude(buf);
        this.onChunk(buf);
      };
      source.connect(worklet);

      this.source = source;
      this.worklet = worklet;
      return { ok: true };
    } catch (cause) {
      await this.teardown();
      return { ok: false, error: "unknown", cause };
    }
  }

  /** Releases the mic and audio graph. The instance can be `start()`ed again. */
  async stop(): Promise<void> {
    await this.teardown();
  }

  /** Permanently disposes the capture; subsequent `start()` calls fail. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    await this.teardown();
  }

  /** Computes and forwards the smoothed RMS amplitude for a PCM chunk. */
  private emitAmplitude(buf: ArrayBuffer): void {
    if (!this.onAmplitude) return;
    const samples = new Int16Array(buf);
    if (samples.length === 0) return;

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i]! / 0x8000;
      sumSquares += normalized * normalized;
    }
    const rawRMS = Math.sqrt(sumSquares / samples.length);
    this.smoothedAmplitude =
      AMPLITUDE_SMOOTHING * rawRMS + AMPLITUDE_SMOOTHING * this.smoothedAmplitude;
    this.onAmplitude(Math.min(this.smoothedAmplitude * AMPLITUDE_SCALE, 1.0));
  }

  private async teardown(): Promise<void> {
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      stopTracks(this.stream);
      this.stream = null;
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      await context.close().catch(() => {});
    }
    this.smoothedAmplitude = 0;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
