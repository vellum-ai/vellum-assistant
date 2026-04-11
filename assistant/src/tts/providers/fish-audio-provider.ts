/**
 * Fish Audio TTS provider adapter.
 *
 * Wraps the existing {@link synthesizeWithFishAudio} function behind the
 * uniform {@link TtsProvider} interface, preserving its streaming chunk
 * callbacks for real-time call playback.
 *
 * Config comes from `services.tts.providers['fish-audio']`. The API key is read
 * from the secure credential store (`fish-audio/api_key`) by the underlying
 * client.
 */

import { synthesizeWithFishAudio } from "../../calls/fish-audio-client.js";
import { getConfig } from "../../config/loader.js";
import type { TtsFishAudioProviderConfig } from "../../config/schemas/tts.js";
import { getLogger } from "../../util/logger.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:fish-audio");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type FishAudioTtsErrorCode =
  | "FISH_AUDIO_TTS_NO_REFERENCE_ID"
  | "FISH_AUDIO_TTS_SYNTHESIS_FAILED";

export class FishAudioTtsError extends Error {
  readonly code: FishAudioTtsErrorCode;

  constructor(code: FishAudioTtsErrorCode, message: string) {
    super(message);
    this.name = "FishAudioTtsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map Fish Audio format names to MIME content types. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
};

/**
 * Resolve the effective reference ID.
 *
 * Priority: request-level `voiceId` > config `referenceId`.
 */
function resolveReferenceId(
  request: TtsSynthesisRequest,
  config: TtsFishAudioProviderConfig,
): string {
  const referenceId = request.voiceId?.trim() || config.referenceId;
  if (!referenceId) {
    throw new FishAudioTtsError(
      "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      "No Fish Audio reference ID provided. " +
        "Set fishAudio.referenceId in config or pass voiceId in the request.",
    );
  }
  return referenceId;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export function createFishAudioProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus"],
  };

  return {
    id: "fish-audio",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const config = getConfig().services.tts.providers["fish-audio"];
      const referenceId = resolveReferenceId(request, config);

      // Build an effective config with the resolved reference ID
      const effectiveConfig: TtsFishAudioProviderConfig = {
        ...config,
        referenceId,
      };

      log.info(
        {
          referenceId,
          format: config.format,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS synthesis",
      );

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          signal: request.signal,
        });
      } catch (err) {
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[config.format] ?? "audio/mpeg";

      return { audio, contentType };
    },

    async synthesizeStream(
      request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      const config = getConfig().services.tts.providers["fish-audio"];
      const referenceId = resolveReferenceId(request, config);

      const effectiveConfig: TtsFishAudioProviderConfig = {
        ...config,
        referenceId,
      };

      log.info(
        {
          referenceId,
          format: config.format,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS streaming synthesis",
      );

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          onChunk,
          signal: request.signal,
        });
      } catch (err) {
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS streaming synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[config.format] ?? "audio/mpeg";

      return { audio, contentType };
    },
  };
}
