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
 * - Google Gemini (`google-gemini`)
 * - xAI (`xai`)
 */

import { batchBoundaryGapReason } from "../providers/speech-to-text/provider-catalog.js";
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
  private readonly language: string | undefined;

  constructor(apiKey: string, language?: string) {
    this.apiKey = apiKey;
    this.language = language;
  }

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const { DeepgramProvider, deepgramLanguageOptions } =
      await import("../providers/speech-to-text/deepgram.js");
    const provider = new DeepgramProvider(
      this.apiKey,
      deepgramLanguageOptions(this.language),
    );

    return provider.transcribe(request.audio, request.mimeType, request.signal);
  }
}

// ---------------------------------------------------------------------------
// Google Gemini adapter — implements BatchTranscriber on top of the Google
// Gemini multimodal provider.
// ---------------------------------------------------------------------------

/**
 * Wraps `GoogleGeminiProvider` behind the `BatchTranscriber` contract.
 *
 * Same error-propagation semantics as WhisperBatchTranscriber: raw provider
 * errors pass through unchanged.
 */
class GoogleGeminiBatchTranscriber implements BatchTranscriber {
  readonly providerId = "google-gemini" as const;
  readonly boundaryId = "daemon-batch" as const;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const { GoogleGeminiProvider } =
      await import("../providers/speech-to-text/google-gemini.js");
    const provider = new GoogleGeminiProvider(this.apiKey);

    return provider.transcribe(request.audio, request.mimeType, request.signal);
  }
}

// ---------------------------------------------------------------------------
// xAI adapter — implements BatchTranscriber on top of the xAI audio
// transcription provider.
// ---------------------------------------------------------------------------

/**
 * Wraps `XAIProvider` behind the `BatchTranscriber` contract.
 *
 * Same error-propagation semantics as WhisperBatchTranscriber: raw provider
 * errors pass through unchanged.
 */
class XAIBatchTranscriber implements BatchTranscriber {
  readonly providerId = "xai" as const;
  readonly boundaryId = "daemon-batch" as const;

  private readonly apiKey: string;
  private readonly language: string | undefined;

  constructor(apiKey: string, language?: string) {
    this.apiKey = apiKey;
    this.language = language;
  }

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const { XAIProvider, xaiLanguageOptions } =
      await import("../providers/speech-to-text/xai.js");
    // Drops "multi" (a Deepgram-specific mode, not a language code); see
    // xaiLanguageOptions.
    const provider = new XAIProvider(
      this.apiKey,
      xaiLanguageOptions(this.language),
    );
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
  if (err instanceof SttError) {
    return err;
  }

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
// Vellum managed adapter — implements BatchTranscriber on top of the
// platform's managed speech endpoint. No API key: the platform connection
// is the credential.
// ---------------------------------------------------------------------------

class VellumManagedBatchTranscriber implements BatchTranscriber {
  readonly providerId = "vellum" as const;
  readonly boundaryId = "daemon-batch" as const;

  constructor(private readonly language: string | undefined) {}

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const { vellumManagedTranscribe } =
      await import("../providers/speech-to-text/vellum-managed.js");
    return vellumManagedTranscribe(
      request.audio,
      request.mimeType,
      request.signal,
      this.language,
    );
  }
}

/**
 * Create a `BatchTranscriber` for the daemon-batch boundary.
 *
 * Callers provide the API key and provider ID (obtained via the authorized
 * secure-keys importer in `providers/speech-to-text/resolve.ts`) so that
 * this module doesn't need to import secure-keys directly. Returns `null`
 * when `apiKey` is falsy, signalling to the caller that batch transcription
 * is unavailable.
 *
 * `language` is the spoken language, forwarded to providers whose batch API
 * accepts one: Deepgram (where `"multi"` also pins nova-3), xAI (where
 * `"multi"` is dropped because it is a Deepgram-specific value, not a
 * language code), and the vellum managed path, whose platform proxy passes
 * it to Deepgram server-side. Whisper and Gemini auto-detect natively and
 * take no language parameter, so it is silently ignored for them.
 *
 * Throws an {@link SttError} for a provider with no batch endpoint at all,
 * which no key can fix and `null` would understate.
 */
export function createDaemonBatchTranscriber(
  apiKey: string | null | undefined,
  providerId: SttProviderId,
  language?: string,
): BatchTranscriber | null {
  // vellum authenticates via the platform connection, not an API key.
  if (providerId === "vellum") {
    return new VellumManagedBatchTranscriber(language);
  }
  if (!apiKey) {
    return null;
  }

  switch (providerId) {
    case "openai-whisper":
      return new WhisperBatchTranscriber(apiKey);
    case "deepgram":
      return new DeepgramBatchTranscriber(apiKey, language);
    case "google-gemini":
      return new GoogleGeminiBatchTranscriber(apiKey);
    case "xai":
      return new XAIBatchTranscriber(apiKey, language);
    case "deepgram-flux":
    case "vellum-flux":
      // Same copy the resolver raises, so a direct factory caller and a
      // config-driven one report the mismatch identically. Both Flux
      // variants are streaming-only: the model has no batch endpoint, BYOK
      // or managed.
      throw new SttError("provider-error", batchBoundaryGapReason(providerId), {
        userFacing: true,
      });
    default: {
      // Exhaustive check — compile error if a new SttProviderId is added
      // without a corresponding case here.
      const _exhaustive: never = providerId;
      return null;
    }
  }
}
