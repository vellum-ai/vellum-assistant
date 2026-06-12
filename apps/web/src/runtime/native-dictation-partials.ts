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
// Mirror of the pcm-downsample worklet's TARGET_SAMPLE_RATE.
const PUSH_SAMPLE_RATE = 16000;

function dictationBridge() {
  return isElectron() ? window.vellum?.helper?.dictation : undefined;
}

/**
 * True when the renderer can route dictation through the mac helper's
 * `SFSpeechRecognizer` — i.e. the macOS Electron shell with a preload new
 * enough to expose the dictation bridge. Settings uses this to decide
 * whether to offer the "macOS Native Dictation" STT provider at all.
 *
 * Requires the one-shot `transcribe`/`onTranscribed` surface, not just the
 * partials methods: those members are optional for version-skew tolerance,
 * and a forced-native session's transcript authority is the whole-recording
 * transcribe — partials alone routinely miss short dictations.
 */
export function isNativeDictationSupported(): boolean {
  const dictation = dictationBridge();
  return !!dictation?.transcribe && !!dictation.onTranscribed;
}

export interface NativeDictationPartialsOptions {
  /**
   * The live recording stream. When provided (and the shell supports
   * pushed audio), its PCM is forwarded to the helper so the recognizer
   * hears exactly what the MediaRecorder records.
   */
  stream?: MediaStream;
}

// One warm AudioContext (+ compiled worklet) shared across sessions:
// constructing and resuming a context plus addModule costs ~1s, which on a
// 1-2s dictation discards most of the utterance (the stream source only
// delivers frames rendered after the graph connects).
let warmContext: AudioContext | null = null;
let warmWorkletReady: Promise<void> | null = null;

async function ensurePumpContext(): Promise<AudioContext> {
  if (!warmContext) {
    warmContext = createAudioContext();
    warmWorkletReady = warmContext.audioWorklet.addModule(WORKLET_MODULE_URL);
  }
  // Contexts constructed outside a user gesture start suspended and the
  // worklet never receives a render quantum — resume explicitly.
  if (warmContext.state !== "running") {
    await warmContext.resume();
  }
  await warmWorkletReady;
  return warmContext;
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
    const context = await ensurePumpContext();
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    let pending: Int16Array[] = [];
    let pendingSamples = 0;
    let sentChunks = 0;
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
      sentChunks += 1;
      if (sentChunks === 1 || sentChunks % 50 === 0) {
        // Byte counts only — never audio content.
        console.info(
          `dictation: pushed audio chunk #${sentChunks} (${merged.byteLength} bytes, context=${context.state})`,
        );
      }
      push(merged.buffer);
    };
    source.connect(worklet);
    console.info(
      `dictation: audio pump started (context=${context.state})`,
    );

    return () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      // The context stays warm for the next session.
    };
  } catch (err) {
    console.warn("native-dictation-partials: audio pump failed", err);
    return null;
  }
}

const TRANSCRIBED_TIMEOUT_MS = 8000;

/**
 * One-shot Apple Speech recognition of a complete recording — the offline
 * transcript authority. Streaming partials race the pump warmup and
 * recognition latency on short dictations; the recorded blob contains
 * every millisecond, so recognizing it whole does not. Resolves `null`
 * when unavailable (off Electron, old shell, decode failure, denied).
 */
export async function transcribeNativeAudioBlob(
  blob: Blob,
): Promise<string | null> {
  const dictation = dictationBridge();
  if (!dictation?.transcribe || !dictation.onTranscribed) {
    return null;
  }

  let pcm: ArrayBuffer;
  try {
    pcm = await decodeBlobTo16kMonoInt16(blob);
  } catch (err) {
    // Sub-second recordings can yield a header-only container that no
    // decoder (nor the STT provider) accepts.
    const detail =
      err instanceof DOMException ? `${err.name}: ${err.message}` : err;
    console.warn("dictation: blob decode for native transcribe failed", detail);
    return null;
  }
  if (pcm.byteLength === 0) return null;

  let resolveText: ((text: string | null) => void) | null = null;
  const unsubscribe = dictation.onTranscribed((event) => {
    resolveText?.(event.text || null);
  });
  try {
    const result = await dictation.transcribe(pcm);
    if (!result.ok) {
      console.info("dictation: native transcribe unavailable:", result.reason);
      return null;
    }
    const text = await new Promise<string | null>((resolve) => {
      resolveText = resolve;
      setTimeout(() => resolve(null), TRANSCRIBED_TIMEOUT_MS);
    });
    // Length only — transcript content must never be logged.
    console.info(
      `dictation: native transcribe ${text ? `chars=${text.length}` : "produced no text"}`,
    );
    return text;
  } catch (err) {
    console.warn("dictation: native transcribe failed", err);
    return null;
  } finally {
    unsubscribe();
  }
}

/**
 * Decode a recorded blob (webm/opus, mp4, …) and resample to the helper's
 * push format. `decodeAudioData` resamples to the context rate, so an
 * offline context pinned at 16 kHz does the conversion in one step.
 */
async function decodeBlobTo16kMonoInt16(blob: Blob): Promise<ArrayBuffer> {
  const raw = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, PUSH_SAMPLE_RATE);
  const audio = await context.decodeAudioData(raw);
  const channels = audio.numberOfChannels;
  const length = audio.length;
  let mono = audio.getChannelData(0);
  if (channels > 1) {
    const mixed = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < length; i++) mixed[i]! += data[i]! / channels;
    }
    mono = mixed;
  }
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const sample = mono[i]!;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

/**
 * Stops the session and resolves the recognizer's FINAL transcript of the
 * whole utterance, or `null` when no final arrives (old shell, timeout).
 * Short dictations end before the first partial, so the final — delivered
 * after the recognizer drains — is the only reliable transcript source.
 */
export type StopNativeDictationPartials = () => Promise<string | null>;

// The helper finalizes ~immediately on-device and self-times-out at 5s;
// this guards against a dead helper. Kept tight: while it pends, the
// finalized subscription lingers and a next session's events would be
// double-handled.
const FINALIZED_TIMEOUT_MS = 4000;

/**
 * Start native dictation partials, delivering cumulative transcription text
 * to `onPartial`. Resolves a stop function on success, or `null` when the
 * capability is unavailable (off Electron, old shell, speech permission
 * denied, recognizer unavailable).
 */
export async function startNativeDictationPartials(
  onPartial: (text: string) => void,
  options?: NativeDictationPartialsOptions,
): Promise<StopNativeDictationPartials | null> {
  const dictation = dictationBridge();
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

  // The final transcript can land before stop() is called (the recognizer
  // self-finalizes on silence) or after — capture both.
  let finalText: string | null = null;
  let finalResolve: ((text: string | null) => void) | null = null;
  const unsubscribeFinal =
    dictation.onFinalized?.((event) => {
      finalText = event.text || null;
      finalResolve?.(finalText);
    }) ?? null;

  const teardownSubscriptions = (): void => {
    unsubscribeFinal?.();
    unsubscribe();
  };

  try {
    const result = await dictation.setPartials(true, undefined, pushMode);
    if (!result.ok) {
      console.info("native-dictation-partials: unavailable:", result.reason);
      teardownSubscriptions();
      return null;
    }
  } catch (err) {
    console.warn("native-dictation-partials: setPartials failed", err);
    teardownSubscriptions();
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
      teardownSubscriptions();
      dictation.setPartials(false).catch(() => {
        // Helper may have exited; nothing to stop.
      });
      return null;
    }
  }

  let stopPromise: Promise<string | null> | null = null;
  return () => {
    if (stopPromise) return stopPromise;
    stopPump?.();
    // No more partials are wanted once stopping — drop that listener now
    // so a quick next session can't double-deliver into this one.
    unsubscribe();
    dictation.setPartials(false).catch(() => {
      // Helper may have exited; nothing to stop.
    });
    stopPromise = (async () => {
      let text = finalText;
      if (!text && unsubscribeFinal) {
        text = await new Promise<string | null>((resolve) => {
          finalResolve = resolve;
          setTimeout(() => resolve(null), FINALIZED_TIMEOUT_MS);
        });
      }
      // The partial listener was already dropped at stop-entry.
      unsubscribeFinal?.();
      if (text !== null) {
        // Length only — transcript content must never be logged.
        console.info(`dictation: native finalized chars=${text.length}`);
      } else {
        console.info("dictation: native finalized not received");
      }
      return text;
    })();
    return stopPromise;
  };
}
