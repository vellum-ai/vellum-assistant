/**
 * Main-thread driver for the 16 kHz mono PCM AudioWorklet capture.
 *
 * Mirrors the macOS `LiveVoiceAudioCapture` surface so the rest of the
 * live-voice manager (built in later PRs) can call into a familiar
 * `start` / `stop` / `shutdown` lifecycle.
 *
 * Pipeline:
 *
 *   getUserMedia → MediaStreamAudioSourceNode → AudioWorkletNode
 *   ("pcm16k-capture-processor" — see public/worklets/) → onChunk callback
 *
 * The worklet posts two message types: `chunk` (PCM16 LE Int16Array, 320
 * samples = 20 ms at 16 kHz) and `amplitude` (peak abs in [0, 1] at ~20 Hz).
 *
 * `stop()` tears down the active capture but keeps the `AudioContext` warm
 * so the next `start()` can resume without paying for context creation
 * again. `shutdown()` fully releases everything (tracks, context).
 *
 * Both methods are idempotent — duplicate calls are safe and cheap.
 */

const WORKLET_MODULE_URL = "/worklets/pcm16k-capture-processor.js";
const WORKLET_PROCESSOR_NAME = "pcm16k-capture-processor";

type AudioContextCtor = new (
  contextOptions?: AudioContextOptions,
) => AudioContext;

interface PcmCaptureChunk {
  pcm16: Int16Array;
  frameCount: number;
  amplitude: number;
}

export interface LiveVoicePcmCaptureStartOptions {
  /** Called once per 320-sample PCM16 LE chunk (~20 ms at 16 kHz). */
  onChunk: (chunk: PcmCaptureChunk) => void;
  /** Called at ~20 Hz with peak amplitude in [0, 1]. Optional UI meter. */
  onAmplitude?: (amplitude: number) => void;
}

interface WorkletChunkMessage {
  type: "chunk";
  pcm16: Int16Array;
  frameCount: number;
  amplitude: number;
}

interface WorkletAmplitudeMessage {
  type: "amplitude";
  amplitude: number;
}

type WorkletMessage = WorkletChunkMessage | WorkletAmplitudeMessage;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class LiveVoicePcmCapture {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private moduleLoaded = false;
  private isShutdown = false;

  async start(options: LiveVoicePcmCaptureStartOptions): Promise<boolean> {
    if (this.isShutdown) return false;
    // If a previous capture is still wired up, tear it down before
    // starting a fresh one — keeps `start` callable as a "make sure
    // we're currently capturing" idempotent step.
    if (this.workletNode) {
      this.stopInternal();
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) return false;

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      return false;
    }

    // If `shutdown()` ran between awaiting permission and getting the
    // stream, release the tracks we just opened and bail.
    if (this.isShutdown) {
      releaseStream(stream);
      return false;
    }

    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) {
      releaseStream(stream);
      return false;
    }

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      const audioContext = this.audioContext;

      if (!this.moduleLoaded) {
        await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
        this.moduleLoaded = true;
      }

      // Shutdown could have raced the worklet module load.
      if (this.isShutdown) {
        releaseStream(stream);
        return false;
      }

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(
        audioContext,
        WORKLET_PROCESSOR_NAME,
      );

      workletNode.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        const data = event.data;
        if (data.type === "chunk") {
          options.onChunk({
            pcm16: data.pcm16,
            frameCount: data.frameCount,
            amplitude: data.amplitude,
          });
        } else if (data.type === "amplitude") {
          options.onAmplitude?.(data.amplitude);
        }
      };

      sourceNode.connect(workletNode);

      this.stream = stream;
      this.sourceNode = sourceNode;
      this.workletNode = workletNode;
      return true;
    } catch {
      releaseStream(stream);
      return false;
    }
  }

  /**
   * Stop the current capture but keep the `AudioContext` warm — cheap
   * to call again from `start()`. The MediaStream is also released so
   * the OS-level mic indicator clears; `start()` opens a fresh stream.
   */
  stop(): void {
    this.stopInternal();
    if (this.stream) {
      releaseStream(this.stream);
      this.stream = null;
    }
  }

  /**
   * Release all resources. Idempotent. After `shutdown()`, `start()`
   * returns `false`.
   */
  shutdown(): void {
    if (this.isShutdown) return;
    this.isShutdown = true;

    this.stopInternal();

    if (this.stream) {
      releaseStream(this.stream);
      this.stream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  private stopInternal(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // Already disconnected — safe to ignore.
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Already disconnected — safe to ignore.
      }
      this.sourceNode = null;
    }
  }
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
