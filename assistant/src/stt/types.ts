/**
 * Provider-agnostic speech-to-text domain types for daemon transcription.
 *
 * These types define the boundary between callers that need audio transcription
 * and the concrete STT provider implementations. The goal is to let daemon
 * callsites program against a single typed interface so that provider swaps are
 * localized to the adapter layer.
 *
 * Two execution modes are supported:
 * - **Batch** — a single audio buffer is sent and a final transcript returned.
 * - **Streaming** — audio chunks are sent over a persistent session, and the
 *   provider emits partial/final transcript events in real time.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Canonical provider identifiers for daemon-hosted STT backends.
 * Extend this union as new providers are integrated.
 */
export type SttProviderId = "openai-whisper" | "deepgram" | "google-gemini";

/**
 * Telephony-specific STT support mode.
 *
 * Describes how a provider can participate in real-time telephony call
 * ingestion when wired through `services.stt`.
 *
 * - `"realtime-ws"` — provider offers a WebSocket streaming endpoint suitable
 *   for low-latency telephony audio. Future PRs will wire this into the
 *   media-stream call adapter.
 * - `"batch-only"` — provider supports only REST batch transcription; not
 *   suitable for real-time telephony.
 * - `"none"` — provider has no telephony support.
 */
export type TelephonySttMode = "realtime-ws" | "batch-only" | "none";

/**
 * Conversation streaming STT support mode.
 *
 * Describes how a provider can participate in real-time conversation
 * streaming when used for chat message capture (chat composer and iOS
 * input bar).
 *
 * - `"realtime-ws"` — provider offers a native WebSocket streaming endpoint
 *   that accepts audio chunks and emits partial/final transcript events
 *   with low latency (e.g. Deepgram live transcription).
 * - `"incremental-batch"` — provider does not offer true streaming but can
 *   be polled with incremental audio batches to approximate streaming
 *   behaviour (e.g. Google Gemini multimodal).
 * - `"none"` — provider has no conversation streaming support; callers
 *   should fall back to batch transcription.
 */
export type ConversationStreamingMode =
  | "realtime-ws"
  | "incremental-batch"
  | "none";

// ---------------------------------------------------------------------------
// Boundary identifier
// ---------------------------------------------------------------------------

/**
 * Runtime boundary through which STT is executed.
 * - `daemon-batch` — transcription runs in the daemon process via a REST API
 *   call to the provider (e.g. OpenAI Whisper).
 * - `daemon-streaming` — transcription runs in the daemon process over a
 *   persistent streaming session (e.g. WebSocket or incremental-batch loop).
 */
export type SttBoundaryId = "daemon-batch" | "daemon-streaming";

// ---------------------------------------------------------------------------
// Call-context hints
// ---------------------------------------------------------------------------

/**
 * Optional metadata hints that a caller can supply when the transcription
 * originates from a phone-call context. These are advisory — providers may
 * ignore hints they do not support.
 *
 * This type is intentionally separate from the batch request so that
 * call-context awareness can be added incrementally without changing the
 * shape for non-call callers.
 */
export interface SttCallContextHints {
  /** BCP-47 language code for the expected speech (e.g. "en-US"). */
  language?: string;
  /** Static vocabulary hints (proper nouns, domain terms) the ASR should prioritize. */
  vocabularyHints?: string[];
  /** Short natural-language prompt to bias the transcription model. */
  prompt?: string;
}

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
  /**
   * Optional call-context hints. Present when the transcription request
   * originates from a telephony call. Providers may use these to improve
   * recognition accuracy.
   */
  callContext?: SttCallContextHints;
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

// ---------------------------------------------------------------------------
// Streaming client events (client -> daemon)
// ---------------------------------------------------------------------------

/**
 * Events that a client sends to the daemon streaming session.
 *
 * The discriminated `type` field lets the runtime session handler
 * dispatch to the correct streaming adapter method without coupling
 * to transport-level framing (WebSocket opcodes, HTTP/2 frames, etc.).
 */
export type SttStreamClientEvent =
  | SttStreamClientAudioEvent
  | SttStreamClientStopEvent;

/** A chunk of audio data to be transcribed. */
export interface SttStreamClientAudioEvent {
  readonly type: "audio";
  /** Raw audio data for the current chunk. */
  readonly audio: Buffer;
  /** MIME type of the audio data (e.g. "audio/webm", "audio/pcm"). */
  readonly mimeType: string;
}

/** Signals that the client has finished sending audio. */
export interface SttStreamClientStopEvent {
  readonly type: "stop";
}

// ---------------------------------------------------------------------------
// Streaming server events (daemon -> client)
// ---------------------------------------------------------------------------

/**
 * Events that the daemon streaming session emits to the client.
 *
 * The discriminated `type` field allows clients to handle partial
 * and final transcripts, errors, and session lifecycle signals in a
 * type-safe manner.
 */
export type SttStreamServerEvent =
  | SttStreamServerPartialEvent
  | SttStreamServerFinalEvent
  | SttStreamServerErrorEvent
  | SttStreamServerClosedEvent;

/**
 * A partial (interim) transcript — may be revised by subsequent
 * partial or final events.
 */
export interface SttStreamServerPartialEvent {
  readonly type: "partial";
  /** Interim transcript text. May change with subsequent events. */
  readonly text: string;
}

/**
 * A final (committed) transcript — this segment will not be revised.
 */
export interface SttStreamServerFinalEvent {
  readonly type: "final";
  /** Committed transcript text for a completed speech segment. */
  readonly text: string;
}

/** An error occurred during streaming transcription. */
export interface SttStreamServerErrorEvent {
  readonly type: "error";
  /** Normalized error category for caller branching. */
  readonly category: SttErrorCategory;
  /** Human-readable error description. */
  readonly message: string;
}

/** The streaming session has closed (no more events will be emitted). */
export interface SttStreamServerClosedEvent {
  readonly type: "closed";
}

// ---------------------------------------------------------------------------
// Streaming transcriber interface
// ---------------------------------------------------------------------------

/**
 * Daemon-hosted streaming transcriber contract.
 *
 * Implementations manage a persistent session that accepts audio chunks
 * and emits partial/final transcript events. The runtime session
 * orchestrator (PR 5) drives this interface from the gateway WebSocket
 * path.
 *
 * Lifecycle:
 * 1. Call {@link start} to open the provider session.
 * 2. Feed audio chunks via {@link sendAudio}.
 * 3. Call {@link stop} when the client finishes recording.
 * 4. The `onEvent` callback receives server events until `closed`.
 */
export interface StreamingTranscriber {
  /** Which provider backs this transcriber. */
  readonly providerId: SttProviderId;
  /** Which runtime boundary this transcriber operates in. */
  readonly boundaryId: "daemon-streaming";

  /**
   * Open the streaming session with the provider.
   *
   * Must be called once before {@link sendAudio}. Rejects if the
   * provider session cannot be established.
   */
  start(onEvent: (event: SttStreamServerEvent) => void): Promise<void>;

  /**
   * Feed a chunk of audio into the streaming session.
   *
   * Callers must not call this before {@link start} resolves or after
   * {@link stop} has been called.
   */
  sendAudio(audio: Buffer, mimeType: string): void;

  /**
   * Signal that the client has finished sending audio.
   *
   * The provider may emit additional final events after stop is called.
   * The session is fully closed when the `onEvent` callback receives a
   * `closed` event.
   */
  stop(): void;
}
