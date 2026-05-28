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
 * Web Audio only pulls render quanta along graph edges that terminate at
 * `audioContext.destination`. With no downstream consumer the worklet's
 * `process()` never runs, so we also connect the worklet through a muted
 * `GainNode` (gain = 0) to the destination. This keeps the graph
 * renderable without producing any audible output.
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
  /**
   * Muted sink that keeps the capture graph connected to
   * `audioContext.destination` so the AudioWorklet's `process()` is
   * actually scheduled. Gain is pinned to 0 — no audible output.
   */
  private muteNode: GainNode | null = null;
  private moduleLoaded = false;
  private isShutdown = false;
  /**
   * Monotonic counter bumped on every `start()`, `stop()`, and
   * `shutdown()`. The async `start()` work captures its generation at
   * entry and re-verifies it after each `await` (and before each
   * mutation). If the counter has moved, a concurrent `stop()`,
   * `shutdown()`, or newer `start()` has superseded this attempt, and
   * the continuation releases any opened stream and bails. Mirrors the
   * macOS `LiveVoiceAudioCapture` generation counter.
   */
  private startGeneration = 0;

  async start(options: LiveVoicePcmCaptureStartOptions): Promise<boolean> {
    if (this.isShutdown) return false;

    // If a previous capture is already wired up synchronously, tear it
    // down so the new start observes a clean slate. Pending async
    // starts are handled by the generation bump below — their
    // continuations will bail without touching `this.stream` etc.
    if (this.workletNode || this.stream) {
      this.stop();
    }

    // Bump the generation: this both cancels any in-flight `start()`
    // continuation (it will observe a stale generation at its next
    // checkpoint) AND captures the current generation for this call.
    const myGen = ++this.startGeneration;

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

    // A concurrent `stop()`, `shutdown()`, or newer `start()` may have
    // run while we awaited permission. Release the tracks we just
    // opened and bail.
    if (myGen !== this.startGeneration || this.isShutdown) {
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
        // Re-check after the worklet module load — `stop()`,
        // `shutdown()`, or a newer `start()` may have raced it.
        if (myGen !== this.startGeneration || this.isShutdown) {
          releaseStream(stream);
          return false;
        }
        this.moduleLoaded = true;
      } else if (myGen !== this.startGeneration || this.isShutdown) {
        // Even when the module is already loaded we re-check, because
        // a concurrent caller may have invalidated us between the
        // permission await and here (e.g. another `start()` chained
        // synchronously).
        releaseStream(stream);
        return false;
      }

      // Chrome's autoplay policy and Safari's tab lifecycle can leave
      // the AudioContext in `"suspended"` after construction. A
      // suspended context never schedules `process()` on the worklet —
      // we'd report capture as started but deliver zero PCM chunks.
      // Resume it before publishing the new graph; on rejection
      // (no user gesture, etc.) bail so the manager surfaces an error.
      if (audioContext.state === "suspended") {
        try {
          await audioContext.resume();
        } catch {
          releaseStream(stream);
          return false;
        }
        // Re-check after the await — same race window as `addModule()`.
        if (myGen !== this.startGeneration || this.isShutdown) {
          releaseStream(stream);
          return false;
        }
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

      // Web Audio only pulls render quanta along graph edges that
      // terminate at `audioContext.destination`. Without a sink the
      // worklet's `process()` is never called, so live voice would
      // receive zero PCM chunks. Route the worklet through a muted
      // GainNode (gain = 0) to the destination — keeps the graph
      // renderable without producing audible output.
      const muteNode = audioContext.createGain();
      muteNode.gain.value = 0;
      workletNode.connect(muteNode);
      muteNode.connect(audioContext.destination);

      // Final guard before publishing the new nodes — even node
      // construction is synchronous, so this is mostly belt-and-
      // suspenders, but cheap.
      if (myGen !== this.startGeneration || this.isShutdown) {
        try {
          workletNode.port.onmessage = null;
          workletNode.disconnect();
        } catch {
          // Best-effort cleanup.
        }
        try {
          sourceNode.disconnect();
        } catch {
          // Best-effort cleanup.
        }
        try {
          muteNode.disconnect();
        } catch {
          // Best-effort cleanup.
        }
        releaseStream(stream);
        return false;
      }

      this.stream = stream;
      this.sourceNode = sourceNode;
      this.workletNode = workletNode;
      this.muteNode = muteNode;
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
   *
   * Also bumps `startGeneration` so any pending `start()` continuation
   * (e.g. still awaiting `getUserMedia` after PTT release) observes a
   * stale generation and releases the stream it opens.
   */
  stop(): void {
    this.startGeneration++;
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
    // Bump for consistency with `stop()` — `isShutdown` already gates
    // the continuation, but the generation check is the primary
    // cancellation signal so we keep them in sync.
    this.startGeneration++;

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
    if (this.muteNode) {
      try {
        this.muteNode.disconnect();
      } catch {
        // Already disconnected — safe to ignore.
      }
      this.muteNode = null;
    }
  }
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
