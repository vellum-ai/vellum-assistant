/**
 * xAI TTS provider adapter.
 *
 * Wraps the xAI text-to-speech API behind the uniform {@link TtsProvider}
 * interface: the REST endpoint (`/v1/tts`) for batch synthesis and the
 * WebSocket endpoint (`wss://api.x.ai/v1/tts`) for chunk streaming. Reads
 * the API key from the secure credential store under
 * `credential/xai/api_key` and the model configuration from the
 * `services.tts.providers.xai` config section.
 */

import { getConfig } from "../../config/loader.js";
import type { TtsXaiProviderConfig } from "../../config/schemas/tts.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { resolvePcmOutputSampleRateHz } from "../pcm-sample-rates.js";
import type { TtsProviderDefinition } from "../provider-definition.js";
import type { StreamReadTimeouts } from "../stream-read.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";
import { synthesizeOverXaiTtsSocket } from "./xai-tts-socket.js";

const log = getLogger("tts:xai");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type XaiTtsErrorCode =
  | "XAI_TTS_NO_API_KEY"
  | "XAI_TTS_HTTP_ERROR"
  | "XAI_TTS_EMPTY_RESPONSE"
  | "XAI_TTS_REQUEST_FAILED"
  | "XAI_TTS_STREAM_TIMEOUT"
  | "XAI_TTS_STREAM_FAILED";

export class XaiTtsError extends Error {
  readonly code: XaiTtsErrorCode;
  readonly statusCode?: number;

  constructor(code: XaiTtsErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = "XaiTtsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_API_BASE = "https://api.x.ai";

const XAI_WS_BASE = "wss://api.x.ai/v1/tts";

/**
 * Sample rates xAI TTS accepts (both REST and WS). Per
 * https://docs.x.ai/developers/model-capabilities/audio/text-to-speech these
 * are 8/16/22.05/24/44.1/48 kHz; the list intentionally matches the
 * `services.tts.providers.xai.sampleRate` config validation.
 */
const SUPPORTED_PCM_SAMPLE_RATES_HZ = [
  8_000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const;

/** Map from xAI codec names to MIME content types. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/** Parameters for xAI's `/v1/tts` output_format payload. */
interface XaiOutputParams {
  /** xAI codec name (`mp3`, `wav`, or `pcm`). */
  codec: string;
  /** Sample rate in Hz. */
  sample_rate: number;
  /** MP3 bit rate. Omitted for non-MP3 codecs. */
  bit_rate?: number;
  /** Content-type key for the FORMAT_CONTENT_TYPE lookup. */
  contentTypeKey: string;
}

/** PCM rate resolver bound to the xAI-supported rate list (e.g. 96 kHz → 48 kHz). */
const resolveXaiPcmSampleRateHz = (request: TtsSynthesisRequest) =>
  resolvePcmOutputSampleRateHz(request, SUPPORTED_PCM_SAMPLE_RATES_HZ);

/**
 * Resolve the xAI output codec, sample rate, and bit rate based on the
 * synthesis request and provider config.
 *
 * **PCM path** (`outputFormat: "pcm"`):
 *   The media-stream transport needs raw headerless PCM for mu-law transcoding.
 *   We request `codec=pcm` at the request's `sampleRateHz` hint clamped to the
 *   nearest xAI-supported rate, defaulting to 16 kHz when no hint is given
 *   (the shared no-hint convention across TTS providers).
 *
 * **MP3 path** (`config.format === "mp3"`):
 *   Uses the configured sample rate and bit rate.
 *
 * **WAV path** (`config.format === "wav"`):
 *   Uses the configured sample rate; bit rate is not meaningful for WAV.
 */
function resolveOutputParams(
  request: TtsSynthesisRequest,
  config: TtsXaiProviderConfig,
): XaiOutputParams {
  const pcmSampleRateHz = resolveXaiPcmSampleRateHz(request);
  if (pcmSampleRateHz != null) {
    return {
      codec: "pcm",
      sample_rate: pcmSampleRateHz,
      contentTypeKey: "pcm",
    };
  }

  if (config.format === "mp3") {
    return {
      codec: "mp3",
      sample_rate: config.sampleRate,
      bit_rate: config.bitRate,
      contentTypeKey: "mp3",
    };
  }

  return {
    codec: "wav",
    sample_rate: config.sampleRate,
    contentTypeKey: "wav",
  };
}

/** Resolve the voice ID: request override > config > default. */
function resolveVoiceId(
  request: TtsSynthesisRequest,
  config: TtsXaiProviderConfig,
): string {
  return request.voiceId?.trim() || config.voiceId || "eve";
}

/** Resolve the xAI API key, throwing `XAI_TTS_NO_API_KEY` when unset. */
async function requireApiKey(): Promise<string> {
  const apiKey = await getSecureKeyAsync(credentialKey("xai", "api_key"));
  if (!apiKey) {
    throw new XaiTtsError(
      "XAI_TTS_NO_API_KEY",
      "xAI API key not configured. " +
        "Add it via: assistant credentials set --service xai --field api_key <key>",
    );
  }
  return apiKey;
}

/**
 * Build the WebSocket synthesis URL. Mirrors the REST `output_format`
 * payload (via {@link resolveOutputParams}) so both transports request
 * identical audio.
 */
function buildStreamUrl(
  request: TtsSynthesisRequest,
  config: TtsXaiProviderConfig,
  outputParams: XaiOutputParams,
): string {
  const params = new URLSearchParams({
    language: config.language,
    voice: resolveVoiceId(request, config),
    codec: outputParams.codec,
    sample_rate: String(outputParams.sample_rate),
  });
  if (outputParams.bit_rate != null) {
    params.set("bit_rate", String(outputParams.bit_rate));
  }
  return `${XAI_WS_BASE}?${params.toString()}`;
}

export function createXaiProvider(
  streamTimeouts: StreamReadTimeouts & { connectTimeoutMs?: number } = {},
): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "pcm"],
  };

  return {
    id: "xai",
    capabilities,
    resolveOutputSampleRateHz: resolveXaiPcmSampleRateHz,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await requireApiKey();

      const config = getConfig().services.tts.providers.xai;
      const output = resolveOutputParams(request, config);
      const voiceId = resolveVoiceId(request, config);

      const body = {
        text: request.text,
        voice_id: voiceId,
        language: config.language,
        output_format: {
          codec: output.codec,
          sample_rate: output.sample_rate,
          ...(output.bit_rate ? { bit_rate: output.bit_rate } : {}),
        },
      };

      log.info(
        {
          voiceId,
          codec: output.codec,
          sampleRate: output.sample_rate,
          textLength: request.text.length,
        },
        "Starting xAI TTS synthesis",
      );

      let response: Response;
      try {
        response = await fetch(`${XAI_API_BASE}/v1/tts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          `xAI TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new XaiTtsError(
          "XAI_TTS_HTTP_ERROR",
          `xAI TTS returned ${response.status}: ${errorText}`,
          response.status,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new XaiTtsError(
          "XAI_TTS_EMPTY_RESPONSE",
          "xAI TTS returned an empty audio response",
        );
      }

      const contentType =
        FORMAT_CONTENT_TYPE[output.contentTypeKey] ?? "audio/mpeg";

      log.debug(
        { bytes: arrayBuffer.byteLength },
        "xAI TTS synthesis complete",
      );

      return {
        audio: Buffer.from(arrayBuffer),
        contentType,
      };
    },

    async synthesizeStream(
      request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await requireApiKey();

      const config = getConfig().services.tts.providers.xai;
      const output = resolveOutputParams(request, config);
      const url = buildStreamUrl(request, config, output);

      log.info(
        {
          codec: output.codec,
          sampleRate: output.sample_rate,
          textLength: request.text.length,
        },
        "Starting xAI streaming TTS synthesis",
      );

      const audio = await synthesizeOverXaiTtsSocket({
        url,
        apiKey,
        text: request.text,
        onChunk,
        signal: request.signal,
        ...streamTimeouts,
        makeTimeoutError: (timeoutMs) =>
          new XaiTtsError(
            "XAI_TTS_STREAM_TIMEOUT",
            `xAI streaming TTS timed out after ${timeoutMs}ms`,
          ),
        makeStreamError: (detail) =>
          new XaiTtsError(
            "XAI_TTS_STREAM_FAILED",
            `xAI streaming TTS failed: ${detail}`,
          ),
        makeEmptyError: () =>
          new XaiTtsError(
            "XAI_TTS_EMPTY_RESPONSE",
            "xAI streaming TTS returned no audio",
          ),
      });

      log.debug(
        { bytes: audio.byteLength },
        "xAI streaming TTS synthesis complete",
      );

      return {
        audio,
        contentType: FORMAT_CONTENT_TYPE[output.contentTypeKey] ?? "audio/mpeg",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * The complete xAI provider definition — catalog metadata plus the runtime
 * adapter — assembled into the canonical catalog by `provider-catalog.ts`.
 */
export const xaiTtsProviderDefinition: TtsProviderDefinition = {
  id: "xai",
  displayName: "xAI",
  subtitle:
    "Text-to-speech from xAI with expressive voices (eve, ara, rex, sal, leo). Requires an xAI API key.",
  supportsVoiceSelection: false,
  apiKeyPlaceholder: "Enter your xAI API key",
  credentialsGuide: {
    description:
      "Sign in to the xAI console, navigate to API Keys, and create a new key.",
    url: "https://console.x.ai/",
    linkLabel: "Open xAI Console",
  },
  callMode: "synthesized-play",
  allowNativeFallback: false,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "pcm"],
  },
  // The adapter honours the PCM hint via the `pcm` codec.
  mediaStreamPlayback: { outputFormat: "pcm" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/xai/api_key",
      displayName: "xAI API Key",
      setCommand:
        "assistant credentials set --service xai --field api_key <key>",
    },
  ],
  adapter: createXaiProvider(),
};
