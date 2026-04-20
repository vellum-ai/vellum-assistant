/**
 * xAI TTS provider adapter.
 *
 * Wraps the xAI REST text-to-speech API (`/v1/tts`) behind the uniform
 * {@link TtsProvider} interface. Reads the API key from the secure credential
 * store under `credential/xai/api_key` and the model configuration from the
 * `services.tts.providers.xai` config section.
 */

import { getConfig } from "../../config/loader.js";
import type { TtsXaiProviderConfig } from "../../config/schemas/tts.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:xai");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type XaiTtsErrorCode =
  | "XAI_TTS_NO_API_KEY"
  | "XAI_TTS_HTTP_ERROR"
  | "XAI_TTS_EMPTY_RESPONSE"
  | "XAI_TTS_REQUEST_FAILED";

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

/**
 * Resolve the xAI output codec, sample rate, and bit rate based on the
 * synthesis request and provider config.
 *
 * **PCM path** (`outputFormat: "pcm"`):
 *   The media-stream transport needs raw headerless PCM for mu-law transcoding.
 *   We request `codec=pcm&sample_rate=16000` — matching the ElevenLabs /
 *   Deepgram 16 kHz PCM convention and the downstream `audioBufferToFrames`
 *   expectation (16 kHz -> 8 kHz downsample).
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
  if (request.outputFormat === "pcm") {
    return {
      codec: "pcm",
      sample_rate: 16_000,
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

export function createXaiProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: false,
    supportedFormats: ["mp3", "wav"],
  };

  return {
    id: "xai",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await getSecureKeyAsync(credentialKey("xai", "api_key"));
      if (!apiKey) {
        throw new XaiTtsError(
          "XAI_TTS_NO_API_KEY",
          "xAI API key not configured. " +
            "Add it via: assistant credentials set --service xai --field api_key <key>",
        );
      }

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
  };
}
