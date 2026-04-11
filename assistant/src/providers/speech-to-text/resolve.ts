import { resolveDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type { SpeechToTextProvider } from "./types.js";

/**
 * Resolve a `SpeechToTextProvider` for daemon-hosted batch transcription.
 *
 * Delegates to the daemon batch transcriber facade so that the provider
 * construction and credential lookup are centralized. The returned object
 * satisfies the existing `SpeechToTextProvider` interface so that all
 * current callsites continue working without changes.
 *
 * Returns `null` when no STT credentials are configured.
 */
export async function resolveSpeechToTextProvider(): Promise<SpeechToTextProvider | null> {
  const transcriber = await resolveDaemonBatchTranscriber();
  if (!transcriber) return null;

  // Adapt the BatchTranscriber interface to the legacy SpeechToTextProvider
  // contract expected by existing callers.
  return {
    async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal) {
      return transcriber.transcribe({ audio, mimeType, signal });
    },
  };
}
