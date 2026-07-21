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
 * Per `clients/web/AGENTS.md` / `docs/CAPACITOR.md` § OS permission requests,
 * callers own any pre-permission UX: no *dismissible* pre-prompt may precede
 * this `getUserMedia` alert on Capacitor iOS. The live-voice composer's
 * first-run card complies by rendering locked (no ✕ / backdrop / Escape, a
 * single "Start talking" that leads straight here) on iOS — see
 * `chat-composer.tsx`'s `handleLiveVoiceStart` and `VoiceFirstRunCard`.
 */

// Import the worklet as a Vite-bundled, *transpiled* classic script asset and
// get its URL. The `?worker&url` suffix is the robust form: it makes Vite
// compile the worklet entry (TS -> JS, IIFE, dependencies inlined) and emit it
// as a standalone asset, then hand us the hashed URL to pass to `addModule()`.
//
// A bare `new URL("./pcm-downsample-worklet.ts", import.meta.url)` does NOT
// work for this: Vite treats it as a static asset and copies the file verbatim,
// so production ships a raw `.ts` file that an `AudioWorklet` cannot parse (TS
// syntax, wrong MIME type) — i.e. the feature would be dead in prod. The dev
// server tolerates on-the-fly TS, which is why this only bites a real build.
// https://vite.dev/guide/worker#import-with-query-suffixes
import WORKLET_MODULE_URL from "./pcm-downsample-worklet.ts?worker&url";

import { createAudioContext, getAudioContextCtor } from "@/domains/chat/voice/audio-context";
import { LIVE_VOICE_AUDIO_FORMAT } from "@/domains/chat/voice/live-voice/protocol";
import { getVoiceInputMediaStream } from "@/utils/voice-input-device";

// Re-exported for capture consumers (e.g. use-live-voice.ts) so they don't need
// to reach into the protocol module. Canonical definition lives in protocol.ts.
export { LIVE_VOICE_AUDIO_FORMAT };

// Matches `use-audio-amplitude.ts` (and the macOS AudioEngineController):
// EMA with alpha 0.5, scaled by 14 and clamped to 1.0.
const AMPLITUDE_SMOOTHING = 0.5;
const AMPLITUDE_SCALE = 14.0;

const WORKLET_PROCESSOR_NAME = "pcm-downsample";

// Coalesce worklet output (one ~43-sample post per 128-frame render quantum,
// ~375/s) into 50 ms / 800-sample frames before handing chunks to the
// consumer. Each chunk becomes its own WebSocket frame on every relay leg
// downstream (client → gateway → daemon → speech relay), so per-quantum
// granularity floods per-message buffers with ~2.7 ms of audio a frame.
// Batching lives on the main thread (not in the worklet) so flush() is
// synchronous with the consumer's forwarding gate — a push-to-talk release
// can drain the tail before the release frame is sent.
const BATCH_SAMPLES = 800;

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
  // Safari exposes only the prefixed `webkitAudioContext`; resolve via the same
  // fallback as `createAudioContext` so we don't gate out a supported browser.
  const Ctor = getAudioContextCtor();
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!Ctor &&
    // AudioWorklet is present on a constructed context's `audioWorklet`.
    "audioWorklet" in Ctor.prototype
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
  // Batch accumulator for onChunk (see BATCH_SAMPLES). Amplitude metering
  // stays per-quantum; only chunk delivery is coalesced.
  private batch = new Int16Array(BATCH_SAMPLES);
  private batchLength = 0;
  private disposed = false;
  // Incremented by stop()/shutdown() so an in-flight start() can detect that
  // it was cancelled mid-await and fully tear down instead of wiring up a mic
  // that the caller has already asked to release.
  private cancelEpoch = 0;

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

    // Snapshot the cancel epoch at entry. A stop()/shutdown() that races our
    // awaits bumps the epoch (and/or sets `disposed`); seeing either change
    // means this start() was cancelled and must not leave the mic live.
    const epoch = this.cancelEpoch;
    const cancelled = () => this.disposed || this.cancelEpoch !== epoch;

    let stream: MediaStream;
    try {
      stream = await getVoiceInputMediaStream();
    } catch (cause) {
      return { ok: false, error: classifyError(cause), cause };
    }

    // A concurrent shutdown()/stop() may have raced the await above.
    if (cancelled()) {
      stopTracks(stream);
      return { ok: false, error: "aborted" };
    }
    this.stream = stream;

    try {
      const context = createAudioContext();
      this.context = context;
      await context.audioWorklet.addModule(WORKLET_MODULE_URL);

      if (cancelled()) {
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
        this.accumulate(buf);
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
    // Cancel any in-flight start() so a getUserMedia/addModule that resolves
    // after this call tears down instead of attaching the stream/worklet.
    this.cancelEpoch++;
    await this.teardown();
  }

  /** Permanently disposes the capture; subsequent `start()` calls fail. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.cancelEpoch++;
    await this.teardown();
  }

  /**
   * Emit any partially-filled batch immediately. Call at a forwarding
   * boundary (push-to-talk release, dictation stop) so the final <50ms of
   * captured speech is not stranded in the accumulator when the consumer
   * closes its gate. Synchronous: onChunk fires before this returns.
   */
  flush(): void {
    if (this.batchLength === 0) return;
    const tail = this.batch.buffer.slice(0, this.batchLength * 2);
    this.batchLength = 0;
    this.onChunk(tail);
  }

  /** Copy a worklet quantum into the batch, emitting each full 50ms frame. */
  private accumulate(buf: ArrayBuffer): void {
    let samples = new Int16Array(buf);
    while (samples.length > 0) {
      const take = Math.min(BATCH_SAMPLES - this.batchLength, samples.length);
      this.batch.set(samples.subarray(0, take), this.batchLength);
      this.batchLength += take;
      samples = samples.subarray(take);
      if (this.batchLength === BATCH_SAMPLES) {
        this.batchLength = 0;
        const full = this.batch;
        this.batch = new Int16Array(BATCH_SAMPLES);
        this.onChunk(full.buffer);
      }
    }
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
      AMPLITUDE_SMOOTHING * rawRMS +
      (1 - AMPLITUDE_SMOOTHING) * this.smoothedAmplitude;
    this.onAmplitude(Math.min(this.smoothedAmplitude * AMPLITUDE_SCALE, 1.0));
  }

  private async teardown(): Promise<void> {
    // Drop any sub-batch tail: a stopped graph has no forwarding consumer
    // left, and a stale tail must not leak into a later start().
    this.batchLength = 0;
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
