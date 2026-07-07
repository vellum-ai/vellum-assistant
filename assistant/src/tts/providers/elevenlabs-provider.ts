/**
 * ElevenLabs TTS provider adapter.
 *
 * Wraps the ElevenLabs REST text-to-speech API (`/v1/text-to-speech/:voiceId`)
 * behind the uniform {@link TtsProvider} interface. Reads the API key from the
 * secure credential store (`elevenlabs/api_key`) and the voice configuration
 * from `services.tts.providers.elevenlabs` config section.
 */

import { getConfig } from "../../config/loader.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../../config/schemas/elevenlabs.js";
import type { TtsElevenLabsProviderConfig } from "../../config/schemas/tts.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type { TtsProviderDefinition } from "../provider-definition.js";
import { readChunkedBody } from "../stream-read.js";
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
  | "ELEVENLABS_TTS_REQUEST_FAILED"
  | "ELEVENLABS_TTS_STREAM_TIMEOUT";

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
// Error-body parser
// ---------------------------------------------------------------------------

/** Maximum number of characters of a fallback raw body to surface in an error message. */
const MAX_RAW_ERROR_BODY_CHARS = 200;

/**
 * Best-effort extraction of a user-facing error message from an ElevenLabs
 * error response body.
 *
 * ElevenLabs returns structured errors in the shape:
 * ```json
 * { "detail": { "status": "...", "code": "...", "message": "..." } }
 * ```
 * but also occasionally returns `{ "message": "..." }`, `{ "detail": "..." }`,
 * HTML pages (502/503 from their CDN), or free-form text. We try the
 * structured shapes first, fall back to a trimmed/truncated raw body, and
 * return `undefined` when nothing useful is present.
 *
 * Exported for unit testing.
 */
export function extractElevenLabsErrorMessage(
  body: string,
): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  // Try JSON envelopes first.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        const root = parsed as { detail?: unknown; message?: unknown };

        // Standard ElevenLabs shape: { detail: { message } }
        if (root.detail && typeof root.detail === "object") {
          const detailMessage = (root.detail as { message?: unknown }).message;
          if (typeof detailMessage === "string" && detailMessage.trim()) {
            return detailMessage.trim();
          }
        }

        // Fallback shape: { detail: "..." }
        if (typeof root.detail === "string" && root.detail.trim()) {
          return root.detail.trim();
        }

        // Fallback shape: { message: "..." }
        if (typeof root.message === "string" && root.message.trim()) {
          return root.message.trim();
        }
      }
    } catch {
      // Not valid JSON — fall through to the raw-body fallback.
    }
  }

  // Raw body fallback (HTML pages, plain text). Truncate to keep error
  // messages reasonable when surfaced to UI clients.
  if (trimmed.length > MAX_RAW_ERROR_BODY_CHARS) {
    return `${trimmed.slice(0, MAX_RAW_ERROR_BODY_CHARS)}…`;
  }
  return trimmed;
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
  config: TtsElevenLabsProviderConfig,
): string {
  const voiceId =
    request.voiceId?.trim() || config.voiceId || DEFAULT_ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_NO_VOICE_ID",
      "No voice ID provided and no default configured. " +
        "Set services.tts.providers.elevenlabs.voiceId in config or pass voiceId in the request.",
    );
  }
  return voiceId;
}

/** ElevenLabs PCM output formats by exact sample rate. */
const PCM_FORMAT_BY_SAMPLE_RATE: Record<number, string> = {
  16000: "pcm_16000",
  22050: "pcm_22050",
  24000: "pcm_24000",
  44100: "pcm_44100",
};

/**
 * Choose the ElevenLabs output format based on the use case and optional
 * format hint.
 *
 * When the caller requests `outputFormat: "pcm"` (e.g. the media-stream
 * transport which needs raw PCM for mu-law transcoding), we map the optional
 * `sampleRateHz` hint to an exact ElevenLabs PCM format — 16-bit signed
 * little-endian. An absent or unmatched hint defaults to `pcm_16000`, which
 * preserves the media-stream transport's behavior (its `audioBufferToFrames`
 * handles the 16 kHz -> 8 kHz downsample).
 *
 * Otherwise:
 * - Phone calls benefit from lower-latency, smaller payloads (mp3 at 22050/32).
 * - Message playback uses higher quality (mp3 at 44100/128).
 */
function resolveOutputFormat(request: TtsSynthesisRequest): string {
  if (request.outputFormat === "pcm") {
    return (
      PCM_FORMAT_BY_SAMPLE_RATE[request.sampleRateHz ?? 16000] ?? "pcm_16000"
    );
  }
  return request.useCase === "phone-call" ? "mp3_22050_32" : "mp3_44100_128";
}

/** Sample rate of a `pcm_*` output format in Hz; undefined for non-PCM formats. */
function pcmFormatSampleRateHz(outputFormat: string): number | undefined {
  return outputFormat.startsWith("pcm_")
    ? Number(outputFormat.slice("pcm_".length))
    : undefined;
}

/**
 * Resolve credentials and config, build the request body, and issue the
 * ElevenLabs TTS HTTP request. Shared by `synthesize` (buffer endpoint) and
 * `synthesizeStream` (`/stream` endpoint). Throws on missing credentials and
 * non-OK responses; resolves with the OK response and the resolved output
 * format and content type.
 */
async function performTtsRequest(
  request: TtsSynthesisRequest,
  { stream }: { stream: boolean },
): Promise<{ response: Response; outputFormat: string; contentType: string }> {
  const apiKey = await getSecureKeyAsync(
    credentialKey("elevenlabs", "api_key"),
  );
  if (!apiKey) {
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_NO_API_KEY",
      "ElevenLabs API key not configured. " +
        "Add it in Settings → Voice or via: assistant credentials set --service elevenlabs --field api_key <key>",
    );
  }

  const config = getConfig().services.tts.providers.elevenlabs;
  const voiceId = resolveVoiceId(request, config);
  const outputFormat = resolveOutputFormat(request);

  const url = stream
    ? `${ELEVENLABS_API_BASE}/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`
    : `${ELEVENLABS_API_BASE}/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;

  // Streaming defaults to the low-latency flash model; batch keeps
  // multilingual for quality. A configured voiceModelId always wins.
  const defaultModelId = stream
    ? "eleven_flash_v2_5"
    : "eleven_multilingual_v2";

  const body: Record<string, unknown> = {
    text: request.text,
    model_id: config.voiceModelId?.trim() || defaultModelId,
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarityBoost,
      speed: config.speed,
    },
  };

  log.info(
    { voiceId, outputFormat, stream, textLength: request.text.length },
    "Starting ElevenLabs TTS synthesis",
  );

  const contentType = FORMAT_CONTENT_TYPE[outputFormat] ?? "audio/mpeg";

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        Accept: contentType,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_REQUEST_FAILED",
      `ElevenLabs TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    // Surface the upstream provider message verbatim when extractable —
    // the daemon route wraps it with a single "TTS synthesis failed:"
    // prefix on the way out. The HTTP status is preserved on `statusCode`
    // and logged by the daemon, so we don't embed it in the message text.
    const message =
      extractElevenLabsErrorMessage(errorText) ??
      `ElevenLabs returned HTTP ${response.status}`;
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_HTTP_ERROR",
      message,
      response.status,
    );
  }

  return { response, outputFormat, contentType };
}

/** Stream-stall timeouts, injectable for tests. */
export interface ElevenLabsStreamTimeouts {
  firstChunkTimeoutMs?: number;
  idleTimeoutMs?: number;
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
  } & ElevenLabsStreamTimeouts,
): Promise<TtsSynthesisResult> {
  const { response, outputFormat, contentType } = await performTtsRequest(
    request,
    { stream: options.stream },
  );

  let audio: Buffer;
  if (options.stream) {
    if (!response.body) {
      throw new ElevenLabsTtsError(
        "ELEVENLABS_TTS_EMPTY_RESPONSE",
        "ElevenLabs streaming TTS returned no response body",
      );
    }
    audio = await readChunkedBody(response.body, {
      onChunk: options.onChunk,
      firstChunkTimeoutMs: options.firstChunkTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      makeTimeoutError: (timeoutMs) =>
        new ElevenLabsTtsError(
          "ELEVENLABS_TTS_STREAM_TIMEOUT",
          `ElevenLabs streaming TTS read timed out after ${timeoutMs}ms`,
        ),
    });
  } else {
    audio = Buffer.from(await response.arrayBuffer());
  }

  if (audio.byteLength === 0) {
    throw new ElevenLabsTtsError(
      "ELEVENLABS_TTS_EMPTY_RESPONSE",
      "ElevenLabs TTS returned an empty audio response",
    );
  }

  log.debug(
    { bytes: audio.byteLength, stream: options.stream },
    "ElevenLabs TTS synthesis complete",
  );

  return {
    audio,
    contentType,
    sampleRateHz: pcmFormatSampleRateHz(outputFormat),
  };
}

export function createElevenLabsProvider(
  streamTimeouts: ElevenLabsStreamTimeouts = {},
): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  };

  return {
    id: "elevenlabs",
    capabilities,
    resolveOutputSampleRateHz: (request) =>
      pcmFormatSampleRateHz(resolveOutputFormat(request)),
    synthesize: (request) => performSynthesis(request, { stream: false }),
    synthesizeStream: (request, onChunk) =>
      performSynthesis(request, { stream: true, onChunk, ...streamTimeouts }),
  };
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * The complete ElevenLabs provider definition — catalog metadata and runtime
 * adapter — assembled into the canonical catalog by `provider-catalog.ts`.
 */
export const elevenLabsTtsProviderDefinition: TtsProviderDefinition = {
  id: "elevenlabs",
  displayName: "ElevenLabs",
  subtitle:
    "High-quality voice synthesis for conversations and read-aloud. Requires an ElevenLabs API key.",
  supportsVoiceSelection: true,
  apiKeyPlaceholder: "sk_…",
  credentialsGuide: {
    description:
      "Sign in to ElevenLabs, go to your Profile, and copy your API key.",
    url: "https://elevenlabs.io/app/settings/api-keys",
    linkLabel: "Open ElevenLabs API Keys",
  },
  callMode: "native-twilio",
  allowNativeFallback: true,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  },
  // The adapter honours the PCM hint via sample-rate-mapped pcm_* output.
  mediaStreamPlayback: { outputFormat: "pcm" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/elevenlabs/api_key",
      displayName: "ElevenLabs API Key",
      setCommand:
        "assistant credentials set --service elevenlabs --field api_key <key>",
    },
  ],
  adapter: createElevenLabsProvider(),
};
