import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type {
  TtsProvider,
  TtsProviderId,
  TtsStreamingSession,
  TtsSynthesisRequest,
  TtsUseCase,
} from "../tts/types.js";

export const DEFAULT_LIVE_VOICE_TTS_SAMPLE_RATE = 24_000;

export type LiveVoiceTtsConfig = Parameters<typeof resolveTtsConfig>[0];

export interface LiveVoiceTtsAudioChunk {
  type: "tts_audio";
  contentType: string;
  sampleRate: number;
  dataBase64: string;
}

export interface LiveVoiceTtsOptions {
  text: string;
  voiceId?: string;
  signal?: AbortSignal;
  useCase?: TtsUseCase;
  outputFormat?: TtsSynthesisRequest["outputFormat"];
  sampleRate?: number;
  config?: LiveVoiceTtsConfig;
  onAudioChunk: (chunk: LiveVoiceTtsAudioChunk) => void;
}

export interface LiveVoiceTtsResult {
  provider: TtsProviderId;
  contentType: string;
  sampleRate: number;
  chunks: number;
  bytes: number;
}

export type LiveVoiceTtsErrorCode =
  | "LIVE_VOICE_TTS_PROVIDER_NOT_CONFIGURED"
  | "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE"
  | "LIVE_VOICE_TTS_CONFIGURATION_ERROR"
  | "LIVE_VOICE_TTS_SYNTHESIS_FAILED";

export class LiveVoiceTtsError extends Error {
  readonly code: LiveVoiceTtsErrorCode;
  readonly provider?: TtsProviderId;
  override readonly cause?: unknown;

  constructor(
    code: LiveVoiceTtsErrorCode,
    message: string,
    options: { provider?: TtsProviderId; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LiveVoiceTtsError";
    this.code = code;
    this.provider = options.provider;
    this.cause = options.cause;
  }
}

interface ResolvedStreamingTtsProvider {
  provider: TtsProvider;
  providerId: TtsProviderId;
  providerConfig: Record<string, unknown>;
}

export async function streamLiveVoiceTtsAudio(
  options: LiveVoiceTtsOptions,
): Promise<LiveVoiceTtsResult> {
  const { provider, providerId, providerConfig } =
    await resolveLiveVoiceStreamingTtsProvider(options.config);
  const sampleRate = resolveSampleRate(options.sampleRate, providerConfig);
  const chunkContentType = resolveChunkContentType(
    provider,
    providerConfig,
    options.outputFormat,
  );
  const canStreamChunks = isRawPcmContentType(chunkContentType);
  let chunks = 0;
  let bytes = 0;

  const emitAudioFrame = (contentType: string, audio: Uint8Array): void => {
    if (audio.byteLength === 0) return;

    chunks += 1;
    bytes += audio.byteLength;
    options.onAudioChunk({
      type: "tts_audio",
      contentType,
      sampleRate,
      dataBase64: Buffer.from(audio).toString("base64"),
    });
  };

  try {
    const result = await provider.synthesizeStream!(
      {
        text: options.text,
        useCase: options.useCase ?? "phone-call",
        voiceId: options.voiceId,
        signal: options.signal,
        outputFormat: options.outputFormat,
      },
      (audioChunk) => {
        if (canStreamChunks) {
          emitAudioFrame(chunkContentType, audioChunk);
        }
      },
    );
    const contentType = result.contentType || chunkContentType;

    if (!canStreamChunks) {
      emitAudioFrame(contentType, result.audio);
    }

    return {
      provider: providerId,
      contentType,
      sampleRate,
      chunks,
      bytes,
    };
  } catch (err) {
    throw normalizeProviderError(err, providerId);
  }
}

// ---------------------------------------------------------------------------
// Persistent streaming sessions
// ---------------------------------------------------------------------------

/**
 * Options for opening a persistent streaming TTS session for live voice.
 *
 * Sessions exist so callers can feed assistant text deltas to a single
 * long-lived transport (typically a WebSocket) instead of opening a fresh
 * connection per speakable segment. That eliminates ~300-500ms of handshake
 * latency per segment for providers that support it (currently xAI).
 */
export interface LiveVoiceTtsSessionOptions {
  voiceId?: string;
  signal?: AbortSignal;
  useCase?: TtsUseCase;
  outputFormat?: TtsSynthesisRequest["outputFormat"];
  sampleRate?: number;
  config?: LiveVoiceTtsConfig;
  onAudioChunk: (chunk: LiveVoiceTtsAudioChunk) => void;
}

/**
 * Live-voice-friendly façade over {@link TtsStreamingSession}. The chunk
 * callback receives audio in the same `LiveVoiceTtsAudioChunk` shape as the
 * one-shot `streamLiveVoiceTtsAudio` path so downstream framing code is
 * identical regardless of which mode is in use.
 */
export interface LiveVoiceTtsSession {
  readonly provider: TtsProviderId;
  readonly contentType: string;
  readonly sampleRate: number;
  appendText(text: string): Promise<void>;
  finalize(): Promise<void>;
  close(): Promise<void>;
}

export type LiveVoiceTtsSessionOpener = (
  options: LiveVoiceTtsSessionOptions,
) => Promise<LiveVoiceTtsSession>;

/**
 * Open a persistent streaming TTS session against the configured provider.
 * Throws {@link LiveVoiceTtsError} with code `LIVE_VOICE_TTS_STREAMING_UNAVAILABLE`
 * if the active provider doesn't support session-mode streaming — callers
 * should fall back to per-segment `streamLiveVoiceTtsAudio` in that case.
 */
export async function openLiveVoiceTtsStreamingSession(
  options: LiveVoiceTtsSessionOptions,
): Promise<LiveVoiceTtsSession> {
  const { provider, providerId, providerConfig } =
    await resolveLiveVoiceStreamingTtsProvider(options.config);

  if (
    !provider.capabilities.supportsStreamingSessions ||
    typeof provider.openStreamingSession !== "function"
  ) {
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE",
      `TTS provider "${providerId}" does not support persistent streaming sessions.`,
      { provider: providerId },
    );
  }

  const sampleRate = resolveSampleRate(options.sampleRate, providerConfig);
  const chunkContentType = resolveChunkContentType(
    provider,
    providerConfig,
    options.outputFormat,
  );
  const canStreamChunks = isRawPcmContentType(chunkContentType);

  if (!canStreamChunks) {
    // Non-PCM session output isn't currently routed to clients chunk-by-chunk
    // — the live-voice WebSocket frame format assumes audio/pcm. Bail out
    // early so callers can fall back to the buffered per-segment path.
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE",
      `TTS provider "${providerId}" does not produce raw PCM output required by streaming-session mode.`,
      { provider: providerId },
    );
  }

  const emitAudioFrame = (audio: Uint8Array): void => {
    if (audio.byteLength === 0) return;
    options.onAudioChunk({
      type: "tts_audio",
      contentType: chunkContentType,
      sampleRate,
      dataBase64: Buffer.from(audio).toString("base64"),
    });
  };

  let providerSession: TtsStreamingSession;
  try {
    providerSession = await provider.openStreamingSession({
      useCase: options.useCase ?? "phone-call",
      voiceId: options.voiceId,
      outputFormat: options.outputFormat,
      signal: options.signal,
      onChunk: (chunk) => emitAudioFrame(chunk),
    });
  } catch (err) {
    throw normalizeProviderError(err, providerId);
  }

  let closed = false;
  return {
    provider: providerId,
    contentType: chunkContentType,
    sampleRate,
    async appendText(text: string): Promise<void> {
      if (closed) return;
      try {
        await providerSession.appendText(text);
      } catch (err) {
        throw normalizeProviderError(err, providerId);
      }
    },
    async finalize(): Promise<void> {
      try {
        await providerSession.finalize();
      } catch (err) {
        throw normalizeProviderError(err, providerId);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await providerSession.close();
      } catch {
        // close errors are swallowed — the caller is already on a shutdown path
      }
    },
  };
}

async function resolveLiveVoiceStreamingTtsProvider(
  configOverride?: LiveVoiceTtsConfig,
): Promise<ResolvedStreamingTtsProvider> {
  const config = configOverride ?? (await loadAssistantConfig());
  const { provider: providerId, providerConfig } = resolveTtsConfig(config);

  let provider: TtsProvider;
  try {
    provider = getTtsProvider(providerId);
  } catch (err) {
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_PROVIDER_NOT_CONFIGURED",
      `TTS provider "${providerId}" is not configured or registered.`,
      { provider: providerId, cause: err },
    );
  }

  if (
    !provider.capabilities.supportsStreaming ||
    typeof provider.synthesizeStream !== "function"
  ) {
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE",
      `TTS provider "${providerId}" does not support streaming synthesis required by live voice.`,
      { provider: providerId },
    );
  }

  return { provider, providerId, providerConfig };
}

async function loadAssistantConfig(): Promise<LiveVoiceTtsConfig> {
  const { getConfig } = await import("../config/loader.js");
  return getConfig();
}

function normalizeProviderError(
  err: unknown,
  providerId: TtsProviderId,
): LiveVoiceTtsError {
  if (err instanceof LiveVoiceTtsError) return err;

  const message = err instanceof Error ? err.message : String(err);
  if (isProviderConfigurationError(err)) {
    return new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_CONFIGURATION_ERROR",
      `Live voice TTS provider "${providerId}" is missing required configuration or credentials: ${message}`,
      { provider: providerId, cause: err },
    );
  }

  return new LiveVoiceTtsError(
    "LIVE_VOICE_TTS_SYNTHESIS_FAILED",
    `Live voice TTS synthesis failed (provider: ${providerId}): ${message}`,
    { provider: providerId, cause: err },
  );
}

function isProviderConfigurationError(err: unknown): boolean {
  const code =
    err instanceof Error && "code" in err
      ? String((err as Error & { code?: unknown }).code)
      : undefined;
  if (
    code?.endsWith("_NO_API_KEY") ||
    code?.endsWith("_NO_REFERENCE_ID") ||
    code?.endsWith("_NO_VOICE_ID")
  ) {
    return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  return /(?:api key|credential|reference id|voice id).*not configured/i.test(
    message,
  );
}

function resolveChunkContentType(
  provider: TtsProvider,
  providerConfig: Record<string, unknown>,
  outputFormat: TtsSynthesisRequest["outputFormat"],
): string {
  if (outputFormat === "pcm") {
    if (provider.capabilities.supportedFormats.includes("pcm")) {
      return "audio/pcm";
    }
    if (provider.capabilities.supportedFormats.includes("wav")) {
      return "audio/wav";
    }
    return "audio/pcm";
  }

  const format =
    typeof providerConfig.format === "string" ? providerConfig.format : "mp3";
  switch (format) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "pcm":
      return "audio/pcm";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

function resolveSampleRate(
  explicitSampleRate: number | undefined,
  providerConfig: Record<string, unknown>,
): number {
  if (isPositiveFiniteNumber(explicitSampleRate)) {
    return explicitSampleRate;
  }

  const configuredSampleRate = providerConfig.sampleRate;
  if (isPositiveFiniteNumber(configuredSampleRate)) {
    return configuredSampleRate;
  }

  return DEFAULT_LIVE_VOICE_TTS_SAMPLE_RATE;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRawPcmContentType(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "audio/pcm";
}
