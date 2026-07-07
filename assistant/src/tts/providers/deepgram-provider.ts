/**
 * Deepgram TTS provider adapter.
 *
 * Wraps the Deepgram REST text-to-speech API (`/v1/speak`) behind the uniform
 * {@link TtsProvider} interface. The endpoint streams its body natively via
 * chunked transfer, so `synthesizeStream` forwards audio chunks as they
 * arrive from the same URL that `synthesize` buffers. Reads the API key from
 * the secure credential store using the shared `deepgram` bare key (shared
 * with STT) and the model configuration from `services.tts.providers.deepgram`
 * config section.
 */

import { getConfig } from "../../config/loader.js";
import type { TtsDeepgramProviderConfig } from "../../config/schemas/tts.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type { TtsProviderDefinition } from "../provider-definition.js";
import {
  consumeSynthesisResponse,
  type StreamReadTimeouts,
} from "../stream-read.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:deepgram");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type DeepgramTtsErrorCode =
  | "DEEPGRAM_TTS_NO_API_KEY"
  | "DEEPGRAM_TTS_HTTP_ERROR"
  | "DEEPGRAM_TTS_EMPTY_RESPONSE"
  | "DEEPGRAM_TTS_REQUEST_FAILED"
  | "DEEPGRAM_TTS_STREAM_TIMEOUT";

export class DeepgramTtsError extends Error {
  readonly code: DeepgramTtsErrorCode;
  readonly statusCode?: number;

  constructor(
    code: DeepgramTtsErrorCode,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "DeepgramTtsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPGRAM_API_BASE = "https://api.deepgram.com";

/**
 * Sample rate for PCM requests that carry no `sampleRateHz` hint. The
 * media-stream transcoder assumes headerless PCM is 16 kHz (the
 * ElevenLabs/Deepgram/xAI convention) and downsamples to 8 kHz telephony.
 */
const DEFAULT_PCM_SAMPLE_RATE_HZ = 16_000;

/**
 * Sample rates Deepgram's linear16 encoding accepts. Per
 * https://developers.deepgram.com/docs/tts-media-output-settings
 * these are 8/16/24/32/48 kHz (22.05 and 44.1 kHz are not supported).
 */
const SUPPORTED_PCM_SAMPLE_RATES_HZ = [
  8_000, 16_000, 24_000, 32_000, 48_000,
] as const;

/** Map from Deepgram encoding names to MIME content types. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  linear16: "audio/pcm",
};

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/** Parameters for Deepgram's `/v1/speak` encoding query string. */
interface DeepgramOutputParams {
  /** Deepgram encoding name (e.g. `mp3`, `linear16`, `opus`). */
  encoding: string;
  /** Container override (`wav` or `none`). Omitted lets Deepgram choose. */
  container?: string;
  /** Sample rate in Hz. Required for raw PCM to avoid Deepgram's 24 kHz default. */
  sample_rate?: number;
  /** Content-type key for the FORMAT_CONTENT_TYPE lookup. */
  contentTypeKey: string;
}

/** Nearest Deepgram-supported PCM sample rate to `hintHz`; ties prefer the higher rate. */
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
 * to the nearest Deepgram-supported rate (e.g. 44.1 kHz → 48 kHz) so the same
 * value is both sent to the API and reported to callers; non-PCM formats carry
 * their rate in the container and report undefined.
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

/**
 * Resolve the Deepgram output encoding, container, and sample rate based on
 * the synthesis request and provider config.
 *
 * **PCM path** (`outputFormat: "pcm"`):
 *   The media-stream transport needs raw headerless PCM for mu-law transcoding.
 *   We request `encoding=linear16&container=none` — 16-bit signed
 *   little-endian with no WAV header — at the request's `sampleRateHz` hint
 *   clamped to the nearest Deepgram-supported rate, defaulting to 16 kHz when
 *   no hint is given. An explicit `sample_rate` is always sent to avoid
 *   Deepgram's 24 kHz default.
 *
 * **WAV path** (`config.format === "wav"`):
 *   Deepgram treats WAV as a container, not an encoding. We translate to
 *   `encoding=linear16&container=wav` so the API returns a valid WAV file.
 *
 * **Other formats** (mp3, opus):
 *   Passed through directly as encoding values.
 */
function resolveOutputParams(
  request: TtsSynthesisRequest,
  config: TtsDeepgramProviderConfig,
): DeepgramOutputParams {
  if (request.outputFormat === "pcm") {
    return {
      encoding: "linear16",
      container: "none",
      sample_rate: resolvePcmOutputSampleRateHz(request),
      contentTypeKey: "linear16",
    };
  }

  if (config.format === "wav") {
    return {
      encoding: "linear16",
      container: "wav",
      contentTypeKey: "wav",
    };
  }

  return { encoding: config.format, contentTypeKey: config.format };
}

/**
 * Resolve credentials and config, build the `/v1/speak` URL, and issue the
 * Deepgram TTS HTTP request. Shared by `synthesize` and `synthesizeStream` —
 * Deepgram's single endpoint streams its body natively, so both paths hit the
 * same URL. Throws on missing credentials and non-OK responses; resolves with
 * the OK response and the resolved content type.
 */
async function performTtsRequest(
  request: TtsSynthesisRequest,
): Promise<{ response: Response; contentType: string }> {
  const apiKey = await getProviderKeyAsync("deepgram");
  if (!apiKey) {
    throw new DeepgramTtsError(
      "DEEPGRAM_TTS_NO_API_KEY",
      "Deepgram API key not configured. " +
        "Add it in Settings → Voice or via: assistant keys set deepgram <key>",
    );
  }

  const config = getConfig().services.tts.providers.deepgram;
  const outputParams = resolveOutputParams(request, config);
  const model = config.model;

  const params = new URLSearchParams({
    model,
    encoding: outputParams.encoding,
  });
  if (outputParams.container) {
    params.set("container", outputParams.container);
  }
  if (outputParams.sample_rate != null) {
    params.set("sample_rate", String(outputParams.sample_rate));
  }
  const url = `${DEEPGRAM_API_BASE}/v1/speak?${params.toString()}`;

  log.info(
    {
      model,
      encoding: outputParams.encoding,
      container: outputParams.container,
      textLength: request.text.length,
    },
    "Starting Deepgram TTS synthesis",
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey}`,
      },
      body: JSON.stringify({ text: request.text }),
      signal: request.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new DeepgramTtsError(
      "DEEPGRAM_TTS_REQUEST_FAILED",
      `Deepgram TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new DeepgramTtsError(
      "DEEPGRAM_TTS_HTTP_ERROR",
      `Deepgram TTS returned ${response.status}: ${errorText}`,
      response.status,
    );
  }

  const contentType =
    FORMAT_CONTENT_TYPE[outputParams.contentTypeKey] ?? "audio/mpeg";

  return { response, contentType };
}

/**
 * Issue the TTS request and consume the response into a complete result.
 * The streaming path forwards chunks via `onChunk` as they arrive, guarded
 * by first-chunk/idle stall timeouts; the buffer path reads the whole body.
 */
async function performSynthesis(
  request: TtsSynthesisRequest,
  options: {
    stream: boolean;
    onChunk?: (chunk: Uint8Array) => void;
  } & StreamReadTimeouts,
): Promise<TtsSynthesisResult> {
  const { response, contentType } = await performTtsRequest(request);

  const audio = await consumeSynthesisResponse(response, {
    ...options,
    makeTimeoutError: (timeoutMs) =>
      new DeepgramTtsError(
        "DEEPGRAM_TTS_STREAM_TIMEOUT",
        `Deepgram streaming TTS read timed out after ${timeoutMs}ms`,
      ),
    makeEmptyError: (kind) =>
      new DeepgramTtsError(
        "DEEPGRAM_TTS_EMPTY_RESPONSE",
        kind === "no-body"
          ? "Deepgram streaming TTS returned no response body"
          : "Deepgram TTS returned an empty audio response",
      ),
  });

  log.debug(
    { bytes: audio.byteLength, stream: options.stream },
    "Deepgram TTS synthesis complete",
  );

  return { audio, contentType };
}

export function createDeepgramProvider(
  streamTimeouts: StreamReadTimeouts = {},
): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus", "pcm"],
  };

  return {
    id: "deepgram",
    capabilities,
    resolveOutputSampleRateHz: resolvePcmOutputSampleRateHz,
    synthesize: (request) => performSynthesis(request, { stream: false }),
    synthesizeStream: (request, onChunk) =>
      performSynthesis(request, { stream: true, onChunk, ...streamTimeouts }),
  };
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * The complete Deepgram provider definition — catalog metadata plus the
 * runtime adapter — assembled into the canonical catalog by
 * `provider-catalog.ts`.
 */
export const deepgramTtsProviderDefinition: TtsProviderDefinition = {
  id: "deepgram",
  displayName: "Deepgram",
  subtitle:
    "Fast, accurate text-to-speech synthesis. Uses the same API key as Deepgram speech-to-text.",
  supportsVoiceSelection: false,
  apiKeyPlaceholder: "Enter your Deepgram API key",
  credentialsGuide: {
    description:
      "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for speech-to-text.",
    url: "https://console.deepgram.com/",
    linkLabel: "Open Deepgram Console",
  },
  callMode: "synthesized-play",
  allowNativeFallback: false,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus", "pcm"],
  },
  // The adapter honours the PCM hint via `linear16` + `container=none`.
  mediaStreamPlayback: { outputFormat: "pcm" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/deepgram/api_key",
      displayName: "Deepgram API Key",
      setCommand: "assistant keys set deepgram <key>",
    },
  ],
  adapter: createDeepgramProvider(),
};
