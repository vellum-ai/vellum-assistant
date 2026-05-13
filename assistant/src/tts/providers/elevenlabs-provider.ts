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

/**
 * Choose the ElevenLabs output format based on the use case and optional
 * format hint.
 *
 * When the caller requests `outputFormat: "pcm"` (e.g. the media-stream
 * transport which needs raw PCM for mu-law transcoding), we use `pcm_16000`
 * — 16-bit signed little-endian at 16 kHz. The media-stream transport's
 * `audioBufferToFrames` handles the 16 kHz -> 8 kHz downsample.
 *
 * Otherwise:
 * - Phone calls benefit from lower-latency, smaller payloads (mp3 at 22050/32).
 * - Message playback uses higher quality (mp3 at 44100/128).
 */
function resolveOutputFormat(request: TtsSynthesisRequest): string {
  if (request.outputFormat === "pcm") {
    return "pcm_16000";
  }
  return request.useCase === "phone-call" ? "mp3_22050_32" : "mp3_44100_128";
}

export function createElevenLabsProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: false,
    supportedFormats: ["mp3", "pcm"],
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
            "Add it in Settings → Voice or via: assistant credentials set --service elevenlabs --field api_key <key>",
        );
      }

      const config = getConfig().services.tts.providers.elevenlabs;
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

      const acceptType = FORMAT_CONTENT_TYPE[outputFormat] ?? "audio/mpeg";

      let response: Response;
      try {
        response = await fetch(`${url}?output_format=${outputFormat}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
            Accept: acceptType,
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
