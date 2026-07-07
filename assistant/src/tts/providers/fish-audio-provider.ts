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

import {
  type FishAudioSynthesisConfig,
  synthesizeWithFishAudio,
} from "../../calls/fish-audio-client.js";
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
 * Sample rate for PCM requests that carry no `sampleRateHz` hint. The
 * media-stream transcoder assumes headerless PCM is 16 kHz (the
 * ElevenLabs/Deepgram/xAI convention) and downsamples to 8 kHz telephony.
 */
const DEFAULT_PCM_SAMPLE_RATE_HZ = 16_000;

/**
 * PCM/WAV sample rates the Fish Audio TTS API accepts. Per
 * https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 * these are 8/16/24/32/44.1 kHz (22.05 and 48 kHz are not supported).
 */
const SUPPORTED_PCM_SAMPLE_RATES_HZ = [
  8_000, 16_000, 24_000, 32_000, 44_100,
] as const;

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
  pcm: "audio/pcm",
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

/** Nearest Fish-supported PCM sample rate to `hintHz`; ties prefer the higher rate. */
function nearestSupportedPcmSampleRateHz(hintHz: number): number {
  return SUPPORTED_PCM_SAMPLE_RATES_HZ.reduce((best, rate) => {
    const bestDelta = Math.abs(best - hintHz);
    const delta = Math.abs(rate - hintHz);
    if (delta < bestDelta || (delta === bestDelta && rate > best)) {
      return rate;
    }
    return best;
  });
}

/**
 * Actual PCM output sample rate for a request. A PCM request's hint is clamped
 * to the nearest Fish-supported rate (e.g. 48 kHz → 44.1 kHz) so the same value
 * is both sent to the API and reported to callers; non-PCM formats carry their
 * rate in the container and report undefined.
 */
function resolvePcmOutputSampleRateHz(
  request: TtsSynthesisRequest,
): number | undefined {
  if (request.outputFormat !== "pcm") {
    return undefined;
  }
  return nearestSupportedPcmSampleRateHz(
    request.sampleRateHz ?? DEFAULT_PCM_SAMPLE_RATE_HZ,
  );
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

async function performSynthesis(
  request: TtsSynthesisRequest,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<TtsSynthesisResult> {
  const config = getConfig().services.tts.providers["fish-audio"];
  const referenceId = resolveReferenceId(request, config);

  // Fish Audio supports raw PCM (16-bit LE, no container) natively; the
  // hinted sample rate is clamped to the nearest API-supported rate.
  const pcmRequested = request.outputFormat === "pcm";
  const effectiveFormat = pcmRequested ? "pcm" : config.format;
  const sampleRateHz = resolvePcmOutputSampleRateHz(request);

  const effectiveConfig: FishAudioSynthesisConfig = {
    ...config,
    referenceId,
    format: effectiveFormat,
  };

  const streaming = Boolean(onChunk);
  log.info(
    {
      referenceId,
      format: effectiveFormat,
      streaming,
      textLength: request.text.length,
    },
    "Starting Fish Audio TTS synthesis",
  );

  let audio: Buffer;
  try {
    audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
      onChunk,
      signal: request.signal,
      sampleRate: sampleRateHz,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new FishAudioTtsError(
      "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
      `Fish Audio TTS ${streaming ? "streaming " : ""}synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const contentType = FORMAT_CONTENT_TYPE[effectiveFormat] ?? "audio/mpeg";

  return { audio, contentType };
}

export function createFishAudioProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus", "pcm"],
  };

  return {
    id: "fish-audio",
    capabilities,
    resolveOutputSampleRateHz: resolvePcmOutputSampleRateHz,
    synthesize: (request) => performSynthesis(request),
    synthesizeStream: (request, onChunk) => performSynthesis(request, onChunk),
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
    supportedFormats: ["mp3", "wav", "opus", "pcm"],
  },
  mediaStreamPlayback: { outputFormat: "pcm" },
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
