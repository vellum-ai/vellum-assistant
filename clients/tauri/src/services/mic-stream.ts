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
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessorNode is deprecated but still works in every modern
      // engine and avoids the worklet bundle complexity we don't need yet.
      const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        this.handleFloatFrame(channel, this.audioContext!.sampleRate);
      };
      this.source.connect(processor);
      processor.connect(this.audioContext.destination);
      this.workletNode = processor;
    } catch (err) {
      this.running = false;
      this.handlers.onError?.(err);
      throw err;
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
  const outputLength = Math.floor((input.length + state.remainder) / ratio);
  const output = new Float32Array(Math.max(0, outputLength));

  let outputIndex = 0;
  let inputIndex = -state.remainder;
  while (outputIndex < outputLength) {
    const lower = Math.floor(inputIndex);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = inputIndex - lower;
    output[outputIndex] =
      input[lower]! * (1 - fraction) + input[upper]! * fraction;
    outputIndex += 1;
    inputIndex += ratio;
  }

  state.remainder = inputIndex - input.length;
  return output;
}
