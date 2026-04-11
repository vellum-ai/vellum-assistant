import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type { SpeechToTextProvider } from "./types.js";

/**
 * Resolve a `SpeechToTextProvider` for daemon-hosted batch transcription.
 *
 * Delegates to the daemon batch transcriber facade so that the provider
 * construction is centralized. Credential lookup stays here (an authorized
 * secure-keys importer) and the API key is passed through.
 *
 * Returns `null` when no STT credentials are configured.
 */
export async function resolveSpeechToTextProvider(): Promise<SpeechToTextProvider | null> {
  const apiKey = await getProviderKeyAsync("openai");
  const transcriber = createDaemonBatchTranscriber(apiKey);
  if (!transcriber) return null;

  // Adapt the BatchTranscriber interface to the legacy SpeechToTextProvider
  // contract expected by existing callers.
  return {
    async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal) {
      return transcriber.transcribe({ audio, mimeType, signal });
    },
  };
}
