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

/**
 * Resolve the Deepgram output encoding, container, and sample rate based on
 * the synthesis request and provider config.
 *
 * **PCM path** (`outputFormat: "pcm"`):
 *   The media-stream transport needs raw headerless PCM for mu-law transcoding.
 *   We request `encoding=linear16&container=none&sample_rate=16000` — 16-bit
 *   signed little-endian at 16 kHz with no WAV header. This matches the
 *   ElevenLabs `pcm_16000` convention and the downstream
 *   `audioBufferToFrames` expectation (16 kHz -> 8 kHz downsample).
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
      sample_rate: 16_000,
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

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new DeepgramTtsError(
          "DEEPGRAM_TTS_EMPTY_RESPONSE",
          "Deepgram TTS returned an empty audio response",
        );
      }

      const contentType =
        FORMAT_CONTENT_TYPE[outputParams.contentTypeKey] ?? "audio/mpeg";

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
