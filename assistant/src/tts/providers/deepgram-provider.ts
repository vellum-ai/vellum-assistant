/**
 * Deepgram TTS provider adapter.
 *
 * Wraps the Deepgram REST text-to-speech API (`/v1/speak`) behind the uniform
 * {@link TtsProvider} interface. Reads the API key from the secure credential
 * store using the shared `deepgram` bare key (shared with STT) and the model
 * configuration from `services.tts.providers.deepgram` config section.
 */

import { getConfig } from "../../config/loader.js";
import type { TtsDeepgramProviderConfig } from "../../config/schemas/tts.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
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
  | "DEEPGRAM_TTS_REQUEST_FAILED";

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

/**
 * Resolve the Deepgram output encoding and container based on the request.
 *
 * When the caller requests `outputFormat: "pcm"` (e.g. the media-stream
 * transport which needs raw PCM for mu-law transcoding), we use `linear16`
 * — 16-bit signed little-endian. The media-stream transport's
 * `audioBufferToFrames` handles the sample rate conversion.
 *
 * Otherwise the configured format is used.
 */
function resolveEncoding(
  request: TtsSynthesisRequest,
  config: TtsDeepgramProviderConfig,
): string {
  if (request.outputFormat === "pcm") {
    return "linear16";
  }
  return config.format;
}

export function createDeepgramProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: false,
    supportedFormats: ["mp3", "wav", "opus"],
  };

  return {
    id: "deepgram",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await getProviderKeyAsync("deepgram");
      if (!apiKey) {
        throw new DeepgramTtsError(
          "DEEPGRAM_TTS_NO_API_KEY",
          "Deepgram API key not configured. " +
            "Add it in Settings → Voice or via: assistant keys set deepgram <key>",
        );
      }

      const config = getConfig().services.tts.providers.deepgram;
      const encoding = resolveEncoding(request, config);
      const model = config.model;

      const url = `${DEEPGRAM_API_BASE}/v1/speak?model=${encodeURIComponent(model)}&encoding=${encodeURIComponent(encoding)}`;

      log.info(
        { model, encoding, textLength: request.text.length },
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

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new DeepgramTtsError(
          "DEEPGRAM_TTS_EMPTY_RESPONSE",
          "Deepgram TTS returned an empty audio response",
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[encoding] ?? "audio/mpeg";

      log.debug(
        { bytes: arrayBuffer.byteLength },
        "Deepgram TTS synthesis complete",
      );

      return {
        audio: Buffer.from(arrayBuffer),
        contentType,
      };
    },
  };
}
