/**
 * Provider-agnostic speech-to-text domain types for daemon batch transcription.
 *
 * These types define the boundary between callers that need audio transcription
 * and the concrete STT provider implementations. The goal is to let daemon
 * callsites program against a single typed interface so that provider swaps are
 * localized to the adapter layer.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Canonical provider identifiers for daemon-hosted batch STT backends.
 * Extend this union as new providers are integrated.
 */
export type SttProviderId = "openai-whisper" | "deepgram";

// ---------------------------------------------------------------------------
// Boundary identifier
// ---------------------------------------------------------------------------

/**
 * Runtime boundary through which STT is executed.
 * - `daemon-batch` — transcription runs in the daemon process via a REST API
 *   call to the provider (e.g. OpenAI Whisper).
 */
export type SttBoundaryId = "daemon-batch";

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/** Input to a batch transcription call. */
export interface SttTranscribeRequest {
  /** Raw audio data (WAV, OGG, MP3, etc.). */
  audio: Buffer;
  /** MIME type of the audio data (e.g. "audio/ogg", "audio/wav"). */
  mimeType: string;
  /** Optional abort signal for cancellation / timeout. */
  signal?: AbortSignal;
}

/** Successful transcription output. */
export interface SttTranscribeResult {
  /** The transcribed text, trimmed. Empty string for silence. */
  text: string;
}

// ---------------------------------------------------------------------------
// Normalized error categories
// ---------------------------------------------------------------------------

/**
 * Normalized error categories that callers can branch on without coupling to
 * provider-specific error shapes or HTTP status codes.
 */
export type SttErrorCategory =
  /** The provider rejected the request due to invalid or missing credentials. */
  | "auth"
  /** The provider rate-limited the request. */
  | "rate-limit"
  /** The request or response timed out. */
  | "timeout"
  /** The audio payload was rejected (unsupported format, too large, etc.). */
  | "invalid-audio"
  /** Any other provider-side or network failure. */
  | "provider-error";

/** A transcription error enriched with a normalized category. */
export class SttError extends Error {
  readonly category: SttErrorCategory;

  constructor(category: SttErrorCategory, message: string) {
    super(message);
    this.name = "SttError";
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// Batch transcriber interface
// ---------------------------------------------------------------------------

/**
 * Daemon-hosted batch transcriber contract.
 *
 * Implementations accept a buffer of audio data and return a transcription
 * result. Errors propagate as raw provider errors (not wrapped in
 * {@link SttError}) so that callers relying on specific error identities
 * (e.g. `AbortError` for cancellation) continue to work. Callers that need
 * normalized error categories should wrap calls with `normalizeSttError()`
 * from `daemon-batch-transcriber.ts`.
 */
export interface BatchTranscriber {
  /** Which provider backs this transcriber. */
  readonly providerId: SttProviderId;
  /** Which runtime boundary this transcriber operates in. */
  readonly boundaryId: SttBoundaryId;

  /**
   * Transcribe a chunk of audio.
   *
   * Rejects with the raw provider error on failure. Use
   * `normalizeSttError()` to convert to an {@link SttError} with a
   * structured {@link SttErrorCategory}.
   */
  transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult>;
}
