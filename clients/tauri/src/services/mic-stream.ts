/**
 * Browser-native mic capture for the Tauri WebView. Uses
 * `navigator.mediaDevices.getUserMedia` + an `AudioWorklet` (or
 * `ScriptProcessorNode` fallback) to hand back 16 kHz mono PCM frames.
 *
 * The HUD currently stays inside the Tauri WebView for audio capture
 * because:
 *   - Tauri 2's official plugin set does not yet ship `tauri-plugin-mic`
 *     for desktop (only mobile).
 *   - WebRTC / `getUserMedia` is widely supported on macOS WebKit and
 *     Linux WebKitGTK and gives us the lowest-friction path.
 *
 * The amplitude callback is a coarse RMS estimate the listener orb
 * reads to drive its pulse animation.
 */

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_FRAME_SAMPLES = 512;

export interface MicStreamHandlers {
  /** Called with int16 PCM frames at {@link TARGET_SAMPLE_RATE}. */
  onFrame(frame: Int16Array): void;
  /** RMS amplitude in [0, 1]. Cheap to compute; emitted every frame. */
  onAmplitude?(amplitude: number): void;
  onError?(error: unknown): void;
}

interface ResampleState {
  remainder: number;
}

export class MicStream {
  private readonly handlers: MicStreamHandlers;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: ScriptProcessorNode | AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private resample: ResampleState = { remainder: 0 };
  private outputBuffer: number[] = [];
  private running = false;

  constructor(handlers: MicStreamHandlers) {
    this.handlers = handlers;
  }

  get sampleRate(): number {
    return TARGET_SAMPLE_RATE;
  }

  get frameSamples(): number {
    return TARGET_FRAME_SAMPLES;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.audioContext = new AudioContext();
      // WebKit (and Tauri's WKWebView) construct AudioContexts in the
      // "suspended" state when there hasn't been a recent user gesture.
      // Without an explicit resume() the ScriptProcessorNode's
      // `onaudioprocess` callback never fires — which surfaces as
      // "the mic looks active but the server receives zero audio
      // chunks". Resume here unconditionally; if the context refuses to
      // resume we fall back to retrying on the next user click via
      // `ensureMicResumed()`.
      if (this.audioContext.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (resumeErr) {
          this.handlers.onError?.(resumeErr);
        }
      }
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessorNode is deprecated but still works in every modern
      // engine and avoids the worklet bundle complexity we don't need yet.
      const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        this.handleFloatFrame(channel, this.audioContext!.sampleRate);
      };
      this.source.connect(processor);
      // Route the processor through a muted gain node before the
      // destination. Without the destination connection some WebKit
      // builds never schedule `onaudioprocess`; with the destination
      // connection (and no muting) the mic input would be echoed
      // straight back through the speakers, causing feedback.
      const sink = this.audioContext.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(this.audioContext.destination);
      this.workletNode = processor;
    } catch (err) {
      this.running = false;
      this.handlers.onError?.(err);
      throw err;
    }
  }

  /**
   * Resume the AudioContext if WebKit suspended it (typically after the
   * window lost focus). Safe to call from a user-gesture handler.
   */
  async ensureResumed(): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        this.handlers.onError?.(err);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      if (this.workletNode && "disconnect" in this.workletNode) {
        this.workletNode.disconnect();
      }
      this.source?.disconnect();
      await this.audioContext?.close();
      this.mediaStream?.getTracks().forEach((track) => {
        track.stop();
      });
    } catch (err) {
      this.handlers.onError?.(err);
    } finally {
      this.workletNode = null;
      this.source = null;
      this.mediaStream = null;
      this.audioContext = null;
      this.outputBuffer.length = 0;
      this.resample = { remainder: 0 };
    }
  }

  private handleFloatFrame(input: Float32Array, sourceRate: number): void {
    if (!this.running) return;

    const downsampled = downsampleFloat32(
      input,
      sourceRate,
      TARGET_SAMPLE_RATE,
      this.resample,
    );

    let rms = 0;
    for (let i = 0; i < downsampled.length; i += 1) {
      rms += downsampled[i]! * downsampled[i]!;
    }
    rms = Math.sqrt(rms / Math.max(1, downsampled.length));
    this.handlers.onAmplitude?.(Math.min(1, rms * 4));

    for (let i = 0; i < downsampled.length; i += 1) {
      this.outputBuffer.push(downsampled[i]!);
    }

    while (this.outputBuffer.length >= TARGET_FRAME_SAMPLES) {
      const slice = this.outputBuffer.splice(0, TARGET_FRAME_SAMPLES);
      const int16 = new Int16Array(TARGET_FRAME_SAMPLES);
      for (let i = 0; i < TARGET_FRAME_SAMPLES; i += 1) {
        const sample = Math.max(-1, Math.min(1, slice[i]!));
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.handlers.onFrame(int16);
    }
  }
}

/**
 * Naive linear-interpolation downsampler. Adequate for wake-word
 * detection (Picovoice's own examples ship the same approach) and
 * STT transport — the daemon's STT layer applies its own resampling
 * if the source rate drifts.
 */
function downsampleFloat32(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
  state: ResampleState,
): Float32Array {
  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  if (!Number.isFinite(ratio) || ratio <= 0 || input.length < 2) {
    state.remainder = 0;
    return new Float32Array(0);
  }

  const samples: number[] = [];
  let inputIndex = state.remainder;
  const maxIndex = input.length - 1;
  while (inputIndex < maxIndex) {
    const lower = Math.floor(inputIndex);
    const upper = Math.min(lower + 1, maxIndex);
    const fraction = inputIndex - lower;
    samples.push(input[lower]! * (1 - fraction) + input[upper]! * fraction);
    inputIndex += ratio;
  }

  // Carry the sampling cursor forward to the next callback frame.
  // This value stays in [0, ratio), so subsequent calls never index
  // into negative sample offsets.
  state.remainder = Math.max(0, inputIndex - input.length);
  return Float32Array.from(samples);
}
