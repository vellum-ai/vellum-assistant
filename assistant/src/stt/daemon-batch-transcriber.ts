/**
 * Daemon batch transcriber facade.
 *
 * Provides a single resolver that returns a `BatchTranscriber` implementation
 * when provider credentials are available, or `null` when no STT backend can
 * be configured. Callers use this instead of constructing provider classes
 * directly.
 *
 * Supported daemon-batch providers:
 * - OpenAI Whisper (`openai-whisper`)
 * - Deepgram (`deepgram`)
 */

import type {
  BatchTranscriber,
  SttProviderId,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "./types.js";
import { SttError } from "./types.js";

// ---------------------------------------------------------------------------
// OpenAI Whisper adapter — implements BatchTranscriber on top of the existing
// OpenAIWhisperProvider low-level class.
// ---------------------------------------------------------------------------

/**
 * Wraps `OpenAIWhisperProvider` behind the `BatchTranscriber` contract.
 *
 * Raw provider errors propagate unchanged so that legacy callers (e.g.
 * `transcribe-audio.ts`) can continue detecting `AbortError` by name.
 * Callers that want normalized categories should wrap calls with
 * {@link normalizeSttError}.
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

    return provider.transcribe(request.audio, request.mimeType, request.signal);
  }
}

// ---------------------------------------------------------------------------
// Deepgram adapter — implements BatchTranscriber on top of the Deepgram
// prerecorded-audio provider.
// ---------------------------------------------------------------------------

/**
 * Wraps `DeepgramProvider` behind the `BatchTranscriber` contract.
 *
 * Same error-propagation semantics as WhisperBatchTranscriber: raw provider
 * errors pass through unchanged.
 */
class DeepgramBatchTranscriber implements BatchTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-batch" as const;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const { DeepgramProvider } =
      await import("../providers/speech-to-text/deepgram.js");
    const provider = new DeepgramProvider(this.apiKey);

    return provider.transcribe(request.audio, request.mimeType, request.signal);
  }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * Map a raw provider error into an {@link SttError} with a normalized category.
 *
 * Callers that need structured error categories should wrap
 * `BatchTranscriber.transcribe()` calls with this utility.
 */
export function normalizeSttError(err: unknown): SttError {
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
 * Create a `BatchTranscriber` for the daemon-batch boundary.
 *
 * Callers provide the API key and provider ID (obtained via the authorized
 * secure-keys importer in `providers/speech-to-text/resolve.ts`) so that
 * this module doesn't need to import secure-keys directly.
 *
 * Returns `null` when `apiKey` is falsy, signalling to the caller that
 * batch transcription is unavailable.
 */
export function createDaemonBatchTranscriber(
  apiKey: string | null | undefined,
  providerId: SttProviderId,
): BatchTranscriber | null {
  if (!apiKey) return null;

  switch (providerId) {
    case "openai-whisper":
      return new WhisperBatchTranscriber(apiKey);
    case "deepgram":
      return new DeepgramBatchTranscriber(apiKey);
    default: {
      // Exhaustive check — compile error if a new SttProviderId is added
      // without a corresponding case here.
      const _exhaustive: never = providerId;
      return null;
    }
  }
}
