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
import type { TtsProviderDefinition } from "../provider-definition.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:fish-audio");

/**
 * Sample rate requested when the caller wants PCM (the phone path).
 * Twilio media streams consume 8 kHz; without this Fish defaults WAV
 * to 44.1 kHz, which the media-stream transcoder would play ~5.5x slow.
 */
const TELEPHONY_SAMPLE_RATE_HZ = 8000;

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
        "Set services.tts.providers.fish-audio.referenceId in config or pass voiceId in the request.",
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

      // When PCM output is requested, override to WAV at 8 kHz. Fish Audio
      // doesn't support raw PCM, but WAV gives us PCM in a container that
      // audioBufferToFrames can extract; the explicit sample rate avoids
      // Fish's 44.1 kHz WAV default.
      const pcmRequested = request.outputFormat === "pcm";
      const effectiveFormat = pcmRequested ? "wav" : config.format;

      // Build an effective config with the resolved reference ID
      // and the potentially overridden format.
      const effectiveConfig: TtsFishAudioProviderConfig = {
        ...config,
        referenceId,
        format: effectiveFormat,
      };

      log.info(
        {
          referenceId,
          format: effectiveFormat,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS synthesis",
      );

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          signal: request.signal,
          sampleRate: pcmRequested ? TELEPHONY_SAMPLE_RATE_HZ : undefined,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[effectiveFormat] ?? "audio/mpeg";

      return { audio, contentType };
    },

    async synthesizeStream(
      request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      const config = getConfig().services.tts.providers["fish-audio"];
      const referenceId = resolveReferenceId(request, config);

      // When PCM output is requested, override to WAV at 8 kHz (see
      // synthesize above).
      const pcmRequested = request.outputFormat === "pcm";
      const effectiveFormat = pcmRequested ? "wav" : config.format;

      const effectiveConfig: TtsFishAudioProviderConfig = {
        ...config,
        referenceId,
        format: effectiveFormat,
      };

      log.info(
        {
          referenceId,
          format: effectiveFormat,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS streaming synthesis",
      );

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          onChunk,
          signal: request.signal,
          sampleRate: pcmRequested ? TELEPHONY_SAMPLE_RATE_HZ : undefined,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS streaming synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[effectiveFormat] ?? "audio/mpeg";

      return { audio, contentType };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * The complete Fish Audio provider definition — catalog metadata plus the
 * runtime adapter — assembled into the canonical catalog by
 * `provider-catalog.ts`.
 */
export const fishAudioTtsProviderDefinition: TtsProviderDefinition = {
  id: "fish-audio",
  displayName: "Fish Audio",
  subtitle:
    "Natural-sounding voice synthesis with custom voice cloning. Requires a Fish Audio API key and voice reference ID.",
  supportsVoiceSelection: true,
  apiKeyPlaceholder: "Enter your Fish Audio API key",
  credentialsGuide: {
    description:
      "Sign in to Fish Audio, navigate to API Keys in your dashboard, and create a new key.",
    url: "https://fish.audio/app/api-keys/",
    linkLabel: "Open Fish Audio API Keys",
  },
  callMode: "synthesized-play",
  allowNativeFallback: true,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus"],
  },
  // The adapter substitutes WAV for the PCM hint (no raw PCM support).
  mediaStreamPlayback: { outputFormat: "wav" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/fish-audio/api_key",
      displayName: "Fish Audio API Key",
      setCommand:
        "assistant credentials set --service fish-audio --field api_key <key>",
    },
  ],
  adapter: createFishAudioProvider(),
};
