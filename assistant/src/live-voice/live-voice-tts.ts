import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type {
  TtsProvider,
  TtsProviderId,
  TtsSynthesisRequest,
  TtsUseCase,
} from "../tts/types.js";

export const DEFAULT_LIVE_VOICE_TTS_SAMPLE_RATE = 24_000;

export type LiveVoiceTtsConfig = Parameters<typeof resolveTtsConfig>[0];

export interface LiveVoiceTtsAudioChunk {
  type: "tts_audio";
  seq: number;
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
  let seq = 0;
  let chunks = 0;
  let bytes = 0;

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
        if (audioChunk.byteLength === 0) return;

        chunks += 1;
        bytes += audioChunk.byteLength;
        options.onAudioChunk({
          type: "tts_audio",
          seq: seq++,
          contentType: chunkContentType,
          sampleRate,
          dataBase64: Buffer.from(audioChunk).toString("base64"),
        });
      },
    );

    return {
      provider: providerId,
      contentType: result.contentType || chunkContentType,
      sampleRate,
      chunks,
      bytes,
    };
  } catch (err) {
    throw normalizeProviderError(err, providerId);
  }
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
