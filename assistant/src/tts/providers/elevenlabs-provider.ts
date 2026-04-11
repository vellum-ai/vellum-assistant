/**
 * ElevenLabs TTS provider adapter.
 *
 * Wraps the ElevenLabs REST text-to-speech API (`/v1/text-to-speech/:voiceId`)
 * behind the uniform {@link TtsProvider} interface. Reads the API key from the
 * secure credential store (`elevenlabs/api_key`) and the voice configuration
 * from the workspace `elevenlabs` config section.
 */

import { getConfig } from "../../config/loader.js";
import type { ElevenLabsConfig } from "../../config/schemas/elevenlabs.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../../config/schemas/elevenlabs.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:elevenlabs");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ElevenLabsTtsErrorCode =
  | "ELEVENLABS_TTS_NO_API_KEY"
  | "ELEVENLABS_TTS_NO_VOICE_ID"
  | "ELEVENLABS_TTS_HTTP_ERROR"
  | "ELEVENLABS_TTS_EMPTY_RESPONSE"
  | "ELEVENLABS_TTS_REQUEST_FAILED";

export class ElevenLabsTtsError extends Error {
  readonly code: ElevenLabsTtsErrorCode;
  readonly statusCode?: number;

  constructor(
    code: ElevenLabsTtsErrorCode,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "ElevenLabsTtsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

/** Map from request output format identifiers to MIME content types. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3_44100_128: "audio/mpeg",
  mp3_22050_32: "audio/mpeg",
  pcm_16000: "audio/pcm",
  pcm_22050: "audio/pcm",
  pcm_24000: "audio/pcm",
  pcm_44100: "audio/pcm",
  ulaw_8000: "audio/basic",
};

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Resolve the effective voice ID for a synthesis request.
 *
 * Priority: request-level `voiceId` > config `voiceId` > built-in default.
 */
function resolveVoiceId(
  request: TtsSynthesisRequest,
  config: ElevenLabsConfig,
): string {
  const voiceId =
    request.voiceId?.trim() || config.voiceId || DEFAULT_ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_NO_VOICE_ID",
      "No voice ID provided and no default configured. " +
        "Set elevenlabs.voiceId in config or pass voiceId in the request.",
    );
  }
  return voiceId;
}

/**
 * Choose the ElevenLabs output format based on the use case.
 *
 * Phone calls benefit from lower-latency, smaller payloads (mp3 at 22050/32).
 * Message playback uses higher quality (mp3 at 44100/128).
 */
function resolveOutputFormat(request: TtsSynthesisRequest): string {
  return request.useCase === "phone-call" ? "mp3_22050_32" : "mp3_44100_128";
}

export function createElevenLabsProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: false,
    supportedFormats: ["mp3"],
  };

  return {
    id: "elevenlabs",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await getSecureKeyAsync(
        credentialKey("elevenlabs", "api_key"),
      );
      if (!apiKey) {
        throw new ElevenLabsTtsError(
          "ELEVENLABS_TTS_NO_API_KEY",
          "ElevenLabs API key not configured. " +
            "Store it via: assistant credentials set --service elevenlabs --field api_key <key>",
        );
      }

      const config = getConfig().elevenlabs;
      const voiceId = resolveVoiceId(request, config);
      const outputFormat = resolveOutputFormat(request);

      const url = `${ELEVENLABS_API_BASE}/v1/text-to-speech/${voiceId}`;

      const body: Record<string, unknown> = {
        text: request.text,
        model_id: config.voiceModelId?.trim() || "eleven_multilingual_v2",
        voice_settings: {
          stability: config.stability,
          similarity_boost: config.similarityBoost,
          speed: config.speed,
        },
      };

      log.info(
        { voiceId, outputFormat, textLength: request.text.length },
        "Starting ElevenLabs TTS synthesis",
      );

      let response: Response;
      try {
        response = await fetch(`${url}?output_format=${outputFormat}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        throw new ElevenLabsTtsError(
          "ELEVENLABS_TTS_REQUEST_FAILED",
          `ElevenLabs TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new ElevenLabsTtsError(
          "ELEVENLABS_TTS_HTTP_ERROR",
          `ElevenLabs TTS returned ${response.status}: ${errorText}`,
          response.status,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new ElevenLabsTtsError(
          "ELEVENLABS_TTS_EMPTY_RESPONSE",
          "ElevenLabs TTS returned an empty audio response",
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[outputFormat] ?? "audio/mpeg";

      log.debug(
        { bytes: arrayBuffer.byteLength },
        "ElevenLabs TTS synthesis complete",
      );

      return {
        audio: Buffer.from(arrayBuffer),
        contentType,
      };
    },
  };
}
