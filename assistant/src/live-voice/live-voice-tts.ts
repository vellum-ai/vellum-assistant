import { getTtsProvider } from "../tts/provider-catalog.js";
import { synthesizeAndEmit } from "../tts/synthesis-stream.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type {
  TtsProvider,
  TtsProviderId,
  TtsSynthesisRequest,
  TtsUseCase,
} from "../tts/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice-tts");

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
  const useCase = options.useCase ?? "phone-call";
  const requestedSampleRate = resolveSampleRate(
    options.sampleRate,
    providerConfig,
  );
  // Frames are labeled with the provider's actual output rate: the streaming
  // path emits chunks before the synthesis result resolves, so the rate must
  // be known up-front — a rate hint the provider cannot honour would
  // otherwise mislabel the audio and play at the wrong speed.
  const providerSampleRate = provider.resolveOutputSampleRateHz?.({
    text: options.text,
    useCase,
    voiceId: options.voiceId,
    outputFormat: options.outputFormat,
    sampleRateHz: requestedSampleRate,
    signal: options.signal,
  });
  let sampleRate = providerSampleRate ?? requestedSampleRate;
  if (sampleRate !== requestedSampleRate) {
    log.warn(
      { provider: providerId, requestedSampleRate, sampleRate },
      "TTS provider output sample rate differs from the requested rate; labeling audio with the provider rate",
    );
  }
  const chunkContentType = resolveChunkContentType(
    provider,
    providerConfig,
    options.outputFormat,
  );
  const canStreamChunks = isRawPcmContentType(chunkContentType);
  let chunks = 0;
  let bytes = 0;

  const emitAudioFrame = (contentType: string, audio: Buffer): void => {
    if (audio.byteLength === 0) {
      return;
    }

    chunks += 1;
    bytes += audio.byteLength;
    options.onAudioChunk({
      type: "tts_audio",
      contentType,
      sampleRate,
      dataBase64: audio.toString("base64"),
    });
  };

  // Non-PCM streams accumulate here and emit one complete frame at the end —
  // compressed formats (mp3/wav/opus) are only playable as a whole payload.
  const bufferedAudio: Buffer[] = [];

  // Provider chunks can split a 16-bit PCM sample across chunk boundaries;
  // a trailing odd byte is carried into the next chunk to keep frames aligned.
  let pcm16Carry: Buffer | undefined;
  const alignPcm16 = (audio: Buffer): Buffer => {
    const combined = pcm16Carry ? Buffer.concat([pcm16Carry, audio]) : audio;
    const alignedLength = combined.byteLength & ~1;
    pcm16Carry =
      alignedLength < combined.byteLength
        ? combined.subarray(alignedLength)
        : undefined;
    return combined.subarray(0, alignedLength);
  };

  try {
    const result = await synthesizeAndEmit({
      provider,
      text: options.text,
      useCase,
      voiceId: options.voiceId,
      outputFormat: options.outputFormat,
      sampleRateHz: requestedSampleRate,
      signal: options.signal,
      onChunk: (chunk) => {
        if (canStreamChunks) {
          emitAudioFrame(
            chunk.contentType || chunkContentType,
            alignPcm16(chunk.audio),
          );
        } else {
          bufferedAudio.push(chunk.audio);
        }
      },
    });

    // A dangling final byte is malformed provider output — drop it rather
    // than emit a torn sample.
    if (pcm16Carry) {
      log.debug(
        { provider: providerId },
        "Dropping trailing odd byte from PCM16 TTS stream",
      );
    }
    const contentType = result.contentType || chunkContentType;

    // Late correction for providers that report the actual rate only on the
    // completed result: it relabels the buffered emit below and the returned
    // result (already-streamed frames keep their up-front label).
    if (
      isPositiveFiniteNumber(result.sampleRateHz) &&
      result.sampleRateHz !== sampleRate
    ) {
      log.warn(
        {
          provider: providerId,
          labeledSampleRate: sampleRate,
          sampleRate: result.sampleRateHz,
        },
        "TTS provider reported a different output sample rate on the completed result",
      );
      sampleRate = result.sampleRateHz;
    }

    // An abort mid-stream resolves without throwing; skip the buffered emit
    // so a truncated payload is never delivered after cancellation.
    if (!canStreamChunks && !result.stopped) {
      emitAudioFrame(contentType, Buffer.concat(bufferedAudio));
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
