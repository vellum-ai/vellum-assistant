/**
 * Vellum-managed incremental-batch streaming STT.
 *
 * The managed speech endpoint is batch-only, so streaming is approximated by
 * the shared incremental-batch strategy. The poll cadence is coarser than
 * Whisper's: every poll re-submits the accumulated audio through the
 * platform, so each one costs a full platform round-trip on top of the
 * provider call.
 */

import { managedSpeechTranscribe } from "../../platform/managed-speech.js";
import {
  IncrementalBatchStreamingTranscriber,
  type IncrementalBatchStreamOptions,
} from "./incremental-batch-stream.js";
import { sttErrorFromManagedSpeech } from "./vellum-managed.js";

/** Minimum interval between platform poll requests (ms). */
const VELLUM_POLL_INTERVAL_MS = 1200;

export class VellumManagedStreamingTranscriber extends IncrementalBatchStreamingTranscriber {
  readonly providerId = "vellum" as const;

  constructor(options: IncrementalBatchStreamOptions = {}) {
    super({ pollIntervalMs: VELLUM_POLL_INTERVAL_MS, ...options });
  }

  protected async runBatchTranscription(
    audio: Buffer,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await managedSpeechTranscribe({
      audio,
      mimeType,
      source: "dictation-stream",
      signal,
    });
    if (!result.ok) {
      throw sttErrorFromManagedSpeech(result);
    }
    return result.value.text;
  }
}
