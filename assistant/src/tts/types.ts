/**
 * Core domain types for the provider-agnostic TTS abstraction.
 *
 * These contracts decouple callers (phone calls, message TTS routes, native
 * clients) from concrete TTS backends (ElevenLabs, Fish Audio, etc.).
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Unique identifier for a registered TTS provider.
 *
 * Values correspond to the provider names already used in config schemas
 * (e.g. `"elevenlabs"`, `"fish-audio"`). New providers simply add a new
 * string to this union — the registry enforces uniqueness at runtime.
 */
export type TtsProviderId =
  | "elevenlabs"
  | "fish-audio"
  | "deepgram"
  | "xai"
  | (string & {});

// ---------------------------------------------------------------------------
// Call-mode discriminator
// ---------------------------------------------------------------------------

/**
 * Describes how a TTS provider integrates with the telephony call path.
 *
 * - `native-twilio`    — Twilio handles TTS natively via ConversationRelay;
 *                         text tokens are forwarded to the relay and Twilio
 *                         synthesises audio using the provider's built-in
 *                         integration.
 * - `synthesized-play` — The assistant synthesises audio via the provider's
 *                         HTTP API and streams chunks to Twilio via `play`
 *                         messages. Used when the provider is not natively
 *                         supported by Twilio.
 */
export type TtsCallMode = "native-twilio" | "synthesized-play";

// ---------------------------------------------------------------------------
// Use-case discriminator
// ---------------------------------------------------------------------------

/**
 * Describes the product surface that is requesting synthesis so providers
 * can tailor format, latency, and quality trade-offs.
 */
export type TtsUseCase =
  /** Real-time phone call — prioritize low latency and streaming. */
  | "phone-call"
  /** In-app message playback — buffer-oriented, higher quality acceptable. */
  | "message-playback";

// ---------------------------------------------------------------------------
// Synthesis request / result
// ---------------------------------------------------------------------------

/** Input to a TTS synthesis call. */
export interface TtsSynthesisRequest {
  /** Pre-sanitized text to synthesize. */
  text: string;

  /** Product surface requesting synthesis. */
  useCase: TtsUseCase;

  /**
   * Optional voice identifier whose format is provider-specific
   * (e.g. an ElevenLabs voice ID or a Fish Audio reference ID).
   */
  voiceId?: string;

  /** Optional abort signal for cancelling in-flight synthesis. */
  signal?: AbortSignal;

  /**
   * Optional hint requesting a specific output encoding from the provider.
   *
   * - `"pcm"` — Request raw PCM output (e.g. 16-bit signed LE). The
   *   media-stream transport sets this because its mu-law transcoder
   *   can handle raw PCM but not compressed formats like mp3/opus.
   *
   * Providers that support the requested format should honour the hint;
   * providers that don't may ignore it and return their default format.
   * The caller must always check `result.contentType` to determine the
   * actual format of the returned audio.
   */
  outputFormat?: "pcm";
}

/** Output of a completed TTS synthesis call. */
export interface TtsSynthesisResult {
  /** Complete audio buffer. */
  audio: Buffer;

  /** MIME type of the returned audio (e.g. `"audio/mpeg"`, `"audio/wav"`). */
  contentType: string;
}

// ---------------------------------------------------------------------------
// Alignment / viseme events
// ---------------------------------------------------------------------------

/**
 * Per-phoneme alignment event emitted by TTS providers that expose
 * character- or phoneme-level alignment metadata alongside the audio
 * stream (e.g. ElevenLabs Turbo with alignment).
 *
 * Consumers (e.g. the Meet avatar lip-sync path) map these events to
 * blendshape weights at the rendered timestamp. Providers that do not
 * expose alignment metadata simply never invoke the callback; the
 * caller is expected to fall back to an amplitude-envelope approximation
 * derived from the PCM stream.
 */
export interface TtsAlignmentEvent {
  /**
   * Phoneme label or character — free-form string that the consumer maps
   * to renderer-specific blendshape weights. Providers typically emit
   * IPA-style phoneme labels, viseme codes, or individual characters
   * depending on their alignment granularity.
   */
  phoneme: string;
  /** Normalized intensity in the range [0, 1]. */
  weight: number;
  /** Milliseconds from the start of the synthesized utterance. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

/** Advertised capabilities of a TTS provider. */
export interface TtsProviderCapabilities {
  /** Whether the provider supports chunk-level streaming via `synthesizeStream`. */
  supportsStreaming: boolean;

  /** Audio formats the provider can produce (e.g. `["mp3", "wav", "opus"]`). */
  supportedFormats: string[];

  /**
   * Whether the provider can emit {@link TtsAlignmentEvent}s via the optional
   * `onAlignment` callback of `synthesizeStream`. Consumers use this to pick
   * between a viseme-driven lip-sync path and an RMS-amplitude fallback.
   *
   * Optional for backwards compatibility — treat `undefined` as `false`.
   */
  alignment?: boolean;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every TTS provider adapter must implement.
 *
 * At minimum a provider must support buffer-oriented synthesis. Streaming
 * synthesis is optional — providers that support it set
 * `capabilities.supportsStreaming` to `true` and implement
 * `synthesizeStream`.
 */
export interface TtsProvider {
  /** Unique provider identifier used for registry lookup. */
  readonly id: TtsProviderId;

  /** Static capability advertisement. */
  readonly capabilities: TtsProviderCapabilities;

  /**
   * Synthesize text and return the complete audio buffer.
   *
   * This is the universal code-path — every provider must implement it.
   */
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;

  /**
   * Synthesize text with chunk-level streaming.
   *
   * Only required when `capabilities.supportsStreaming` is `true`.
   * The `onChunk` callback is invoked with each audio chunk as it arrives
   * from the upstream provider. The returned promise resolves with the
   * complete concatenated result once all chunks have been delivered.
   *
   * Providers that advertise `capabilities.alignment === true` also invoke
   * the optional `onAlignment` callback with per-phoneme alignment events
   * interleaved with the audio chunks. Providers that don't support
   * alignment simply never call it; callers must tolerate a silent
   * channel and fall back to amplitude-based heuristics.
   */
  synthesizeStream?(
    request: TtsSynthesisRequest,
    onChunk: (chunk: Uint8Array) => void,
    onAlignment?: (event: TtsAlignmentEvent) => void,
  ): Promise<TtsSynthesisResult>;
}
