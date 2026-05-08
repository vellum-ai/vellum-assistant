/**
 * Wake-word detection types.
 *
 * The wake-word subsystem watches a continuous audio stream and emits a
 * `wake` event whenever the configured keyword is detected. The first
 * concrete implementation is {@link PorcupineWakeWordDetector}, but the
 * abstraction is provider-agnostic so a future on-device whisper-based
 * detector or a server-side Picovoice Cobra wrapper can drop in without
 * the live-voice session caring which engine fired.
 */

export type WakeWordProviderId = "picovoice-porcupine";

/**
 * One of Porcupine's bundled keywords. These ship with the Node SDK and
 * require no separate `.ppn` asset. We restrict the union to the few
 * keywords that make sense as Jarvis-style triggers; users with a
 * Picovoice Console license can swap in a custom `.ppn` via
 * {@link WakeWordKeywordConfig.path}.
 */
export const BUILTIN_PORCUPINE_KEYWORDS = [
  "alexa",
  "americano",
  "blueberry",
  "bumblebee",
  "computer",
  "grapefruit",
  "grasshopper",
  "hey google",
  "hey siri",
  "jarvis",
  "ok google",
  "picovoice",
  "porcupine",
  "terminator",
] as const;

export type BuiltinPorcupineKeyword =
  (typeof BUILTIN_PORCUPINE_KEYWORDS)[number];

/**
 * Source for a single wake-word keyword. Either a built-in keyword
 * shipped with the Porcupine Node SDK (no asset required), or a path to
 * a `.ppn` keyword file produced via the Picovoice Console.
 */
export interface WakeWordKeywordConfig {
  readonly label: string;
  readonly source:
    | { readonly kind: "builtin"; readonly keyword: BuiltinPorcupineKeyword }
    | { readonly kind: "file"; readonly path: string };
  /**
   * Detection sensitivity in [0, 1]. Higher values trigger more easily
   * but increase the false-positive rate. 0.5 is the Picovoice default.
   */
  readonly sensitivity: number;
}

export interface WakeWordEvent {
  /** Index into the configured keyword list. */
  readonly keywordIndex: number;
  readonly keywordLabel: string;
  /** Wall-clock timestamp at detection in ms. */
  readonly detectedAt: number;
}

export type WakeWordListener = (event: WakeWordEvent) => void;

/**
 * Public contract for any wake-word engine. Implementations consume
 * 16-bit signed PCM mono audio frames at the engine's expected sample
 * rate (16 kHz for Porcupine) and fire `onWake` whenever a keyword
 * matches.
 */
export interface WakeWordDetector {
  readonly providerId: WakeWordProviderId;
  /** PCM sample rate the engine expects (Hz). */
  readonly sampleRate: number;
  /** Audio frame length in PCM samples the engine expects per `processFrame` call. */
  readonly frameLength: number;
  /** Configured keyword labels in order. */
  readonly keywordLabels: readonly string[];

  start(onWake: WakeWordListener): Promise<void>;
  /**
   * Push a frame of int16 PCM samples. Must contain exactly
   * {@link frameLength} samples; the caller is responsible for chunking
   * raw audio to that boundary. Returns the matching keyword index, or
   * `-1` when no wake fired during this frame.
   */
  processFrame(samples: Int16Array): number;
  stop(): Promise<void>;
}

export interface WakeWordEngineOptions {
  /** Picovoice Console access key. */
  readonly accessKey: string;
  /** One or more keywords to listen for. At least one is required. */
  readonly keywords: readonly WakeWordKeywordConfig[];
  /** Override the default model file (`.pv`) — rarely needed. */
  readonly modelPath?: string;
}
