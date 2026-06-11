/**
 * Runtime wrapper for the mac helper's local speech-recognition partials.
 *
 * The helper runs `SFSpeechRecognizer` and streams cumulative partial
 * transcriptions — the dictation overlay's live-text source when daemon
 * streaming STT is unreachable (platform-managed assistants whose runtime
 * traffic rides the platform proxy have no gateway WebSocket the renderer
 * could stream against). The same role the native recognizer played in the
 * legacy Swift client.
 *
 * Audio source: when the caller provides the recording `MediaStream` (and
 * the shell supports it), this PUSHES the renderer's own PCM to the helper
 * — one mic capture total. The helper must not open the device itself: a
 * second capture client on the renderer's device either reads silence or
 * kills the renderer's stream (observed both ways on Studio Display
 * Microphone). Without a stream, the helper falls back to tapping the
 * system-default input.
 *
 * Off Electron, and on shells that predate the channel, this no-ops by
 * resolving `null`.
 */

// Same Vite worklet-asset form as live-voice/pcm-capture.ts — see its
// docblock for why `?worker&url` is required (a bare new URL() ships raw TS
// that AudioWorklet cannot parse in production builds).
import WORKLET_MODULE_URL from "@/domains/chat/voice/live-voice/pcm-downsample-worklet.ts?worker&url";

import { createAudioContext } from "@/domains/chat/voice/audio-context";
import { isElectron } from "@/runtime/is-electron";

const WORKLET_PROCESSOR_NAME = "pcm-downsample";

// The worklet emits one tiny chunk per render quantum (~8ms at 16 kHz);
// batch to ~100ms before crossing the IPC + JSON-RPC boundary.
const PUSH_BATCH_SAMPLES = 1600;

export interface NativeDictationPartialsOptions {
  /**
   * The live recording stream. When provided (and the shell supports
   * pushed audio), its PCM is forwarded to the helper so the recognizer
   * hears exactly what the MediaRecorder records.
   */
  stream?: MediaStream;
}

/**
 * Build the AudioWorklet pump that feeds the recording stream's PCM to the
 * helper. Returns a teardown function, or `null` when the audio graph
 * can't be constructed (missing AudioWorklet, context failure).
 */
async function startAudioPump(
  stream: MediaStream,
  push: (chunk: ArrayBuffer) => void,
): Promise<(() => void) | null> {
  try {
    const context = createAudioContext();
    await context.audioWorklet.addModule(WORKLET_MODULE_URL);
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    let pending: Int16Array[] = [];
    let pendingSamples = 0;
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const chunk = new Int16Array(event.data);
      if (chunk.length === 0) return;
      pending.push(chunk);
      pendingSamples += chunk.length;
      if (pendingSamples < PUSH_BATCH_SAMPLES) return;
      const merged = new Int16Array(pendingSamples);
      let offset = 0;
      for (const part of pending) {
        merged.set(part, offset);
        offset += part.length;
      }
      pending = [];
      pendingSamples = 0;
      push(merged.buffer);
    };
    source.connect(worklet);

    return () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      void context.close().catch(() => {
        // Already closed.
      });
    };
  } catch (err) {
    console.warn("native-dictation-partials: audio pump failed", err);
    return null;
  }
}

/**
 * Start native dictation partials, delivering cumulative transcription text
 * to `onPartial`. Resolves a stop function on success, or `null` when the
 * capability is unavailable (off Electron, old shell, speech permission
 * denied, recognizer unavailable).
 */
export async function startNativeDictationPartials(
  onPartial: (text: string) => void,
  options?: NativeDictationPartialsOptions,
): Promise<(() => void) | null> {
  const dictation = isElectron()
    ? window.vellum?.helper?.dictation
    : undefined;
  if (!dictation) {
    return null;
  }

  const pushChunk = dictation.pushAudioChunk?.bind(dictation);
  const stream = options?.stream;
  const pushMode = !!stream && !!pushChunk;

  // Subscribe before enabling so a fast first partial isn't dropped.
  const unsubscribe = dictation.onPartial((event) => {
    onPartial(event.text);
  });

  try {
    const result = await dictation.setPartials(true, undefined, pushMode);
    if (!result.ok) {
      console.info("native-dictation-partials: unavailable:", result.reason);
      unsubscribe();
      return null;
    }
  } catch (err) {
    console.warn("native-dictation-partials: setPartials failed", err);
    unsubscribe();
    return null;
  }

  // Enable first, pump second: the partials owner is registered by the
  // enable call, and chunks from non-owners are dropped in main. The
  // helper buffers pushed PCM while its session is still authorizing, so
  // nothing is lost on first use.
  let stopPump: (() => void) | null = null;
  if (pushMode) {
    stopPump = await startAudioPump(stream, (chunk) => pushChunk(chunk));
    if (!stopPump) {
      // Without audio the session would sit silent forever — tear down so
      // the caller knows partials aren't running.
      unsubscribe();
      dictation.setPartials(false).catch(() => {
        // Helper may have exited; nothing to stop.
      });
      return null;
    }
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopPump?.();
    unsubscribe();
    dictation.setPartials(false).catch(() => {
      // Helper may have exited; nothing to stop.
    });
  };
}
