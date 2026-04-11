/**
 * Daemon batch transcriber facade.
 *
 * Provides a single resolver that returns a `BatchTranscriber` implementation
 * when provider credentials are available, or `null` when no STT backend can
 * be configured. Callers use this instead of constructing provider classes
 * directly.
 *
 * Currently the only daemon-batch provider is OpenAI Whisper. As new providers
 * are added, this module can select the appropriate adapter based on
 * configuration or feature flags.
 */

import { getProviderKeyAsync } from "../security/secure-keys.js";
import type {
  BatchTranscriber,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "./types.js";
import { SttError } from "./types.js";

// ---------------------------------------------------------------------------
// OpenAI Whisper adapter — implements BatchTranscriber on top of the existing
// OpenAIWhisperProvider low-level class.
// ---------------------------------------------------------------------------

/**
 * Wraps `OpenAIWhisperProvider` behind the `BatchTranscriber` contract and
 * normalizes its errors into `SttError` categories.
 */
class WhisperBatchTranscriber implements BatchTranscriber {
  readonly providerId = "openai-whisper" as const;
  readonly boundaryId = "daemon-batch" as const;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    // Lazy-import so the module graph stays lightweight for callers that
    // only need the resolver, not the provider.
    const { OpenAIWhisperProvider } =
      await import("../providers/speech-to-text/openai-whisper.js");
    const provider = new OpenAIWhisperProvider(this.apiKey);

    try {
      return await provider.transcribe(
        request.audio,
        request.mimeType,
        request.signal,
      );
    } catch (err: unknown) {
      throw normalizeSttError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

function normalizeSttError(err: unknown): SttError {
  if (err instanceof SttError) return err;

  const message = err instanceof Error ? err.message : String(err);

  // Abort / timeout
  if (err instanceof Error && err.name === "AbortError") {
    return new SttError("timeout", message);
  }

  // Auth (401 / 403)
  if (/\b40[13]\b/.test(message)) {
    return new SttError("auth", message);
  }

  // Rate limit (429)
  if (/\b429\b/.test(message) || /rate.?limit/i.test(message)) {
    return new SttError("rate-limit", message);
  }

  // Invalid audio (400 with recognisable hints)
  if (/\b400\b/.test(message) && /audio|format|file/i.test(message)) {
    return new SttError("invalid-audio", message);
  }

  return new SttError("provider-error", message);
}

// ---------------------------------------------------------------------------
// Public resolver / factory
// ---------------------------------------------------------------------------

/**
 * Resolve a `BatchTranscriber` for the daemon-batch boundary.
 *
 * Returns `null` when the required provider credentials are not configured,
 * signalling to the caller that batch transcription is unavailable.
 */
export async function resolveDaemonBatchTranscriber(): Promise<BatchTranscriber | null> {
  const apiKey = await getProviderKeyAsync("openai");
  if (!apiKey) return null;
  return new WhisperBatchTranscriber(apiKey);
}
