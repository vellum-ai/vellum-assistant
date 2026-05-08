/**
 * Wake-word subsystem entrypoint.
 *
 * Use {@link createWakeWordDetector} to build an engine from the
 * `voice.wakeWord` config block. Returns `null` when wake-word
 * detection is disabled or the access key is missing — callers must
 * treat that as "PTT only", not an error.
 */

import {
  PorcupineWakeWordDetector,
  WakeWordFrameAccumulator,
} from "./porcupine.js";
import type {
  WakeWordDetector,
  WakeWordEngineOptions,
  WakeWordKeywordConfig,
  WakeWordProviderId,
} from "./types.js";

export {
  PorcupineWakeWordDetector,
  WakeWordFrameAccumulator,
} from "./porcupine.js";
export type {
  BuiltinPorcupineKeyword,
  WakeWordDetector,
  WakeWordEngineOptions,
  WakeWordEvent,
  WakeWordKeywordConfig,
  WakeWordListener,
  WakeWordProviderId,
} from "./types.js";
export { BUILTIN_PORCUPINE_KEYWORDS } from "./types.js";

export interface CreateWakeWordDetectorInput {
  readonly provider: WakeWordProviderId;
  readonly accessKey: string | null;
  readonly keywords: readonly WakeWordKeywordConfig[];
  readonly modelPath?: string;
}

/**
 * Build a wake-word detector instance from caller-supplied config.
 * Returns `null` when the access key is missing — the caller should
 * fall back to PTT in that case rather than treating it as a hard
 * failure.
 */
export function createWakeWordDetector(
  input: CreateWakeWordDetectorInput,
): WakeWordDetector | null {
  if (!input.accessKey || input.accessKey.length === 0) return null;
  if (input.keywords.length === 0) return null;

  const options: WakeWordEngineOptions = {
    accessKey: input.accessKey,
    keywords: input.keywords,
    ...(input.modelPath ? { modelPath: input.modelPath } : {}),
  };

  switch (input.provider) {
    case "picovoice-porcupine":
      return new PorcupineWakeWordDetector(options);
  }
}

/** Convenience helper for callers that want the accumulator + detector pair. */
export function createWakeWordPipeline(input: CreateWakeWordDetectorInput): {
  detector: WakeWordDetector;
  accumulator: WakeWordFrameAccumulator;
} | null {
  const detector = createWakeWordDetector(input);
  if (!detector) return null;
  return { detector, accumulator: new WakeWordFrameAccumulator(detector) };
}
