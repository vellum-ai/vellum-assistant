/**
 * xAI TTS provider adapter.
 *
 * Wraps the xAI text-to-speech APIs behind the uniform {@link TtsProvider}
 * interface. Buffer synthesis uses REST (`POST /v1/tts`); streaming synthesis
 * uses the bidirectional WebSocket endpoint (`wss://api.x.ai/v1/tts`).
 *
 * Reads the API key from the secure credential store under
 * `credential/xai/api_key` first, then falls back to the `XAI_API_KEY`
 * environment variable so a value in `.env` / `.env.local` works
 * out of the box for local development. Model/voice configuration is
 * read from the `services.tts.providers.xai` config section.
 */

import { getConfig } from "../../config/loader.js";
import type { TtsXaiProviderConfig } from "../../config/schemas/tts.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsStreamingSession,
  TtsStreamingSessionOptions,
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

interface XaiStreamingEvent {
  type?: string;
  delta?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_API_BASE = "https://api.x.ai";
const XAI_TTS_WS_BASE = "wss://api.x.ai/v1/tts";
// Lower-latency mode can produce very small bursty chunks that sound choppy
// over realtime playback links. Favor stable cadence for live voice.
const XAI_STREAMING_LATENCY_MODE = "0";

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

/**
 * Resolve the xAI API key.
 *
 * Secure credential store first (`credential/xai/api_key`), then the
 * `XAI_API_KEY` environment variable. The env-var fallback matches how
 * the LLM provider abstraction handles keys (see `getProviderKeyAsync`)
 * so a value placed in `.env.local` works without an explicit
 * `assistant credentials set` step.
 */
async function resolveXaiApiKey(): Promise<string | undefined> {
  const stored = await getSecureKeyAsync(credentialKey("xai", "api_key"));
  if (stored) return stored;
  const envValue = process.env.XAI_API_KEY?.trim();
  return envValue && envValue.length > 0 ? envValue : undefined;
}

export function createXaiProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportsStreamingSessions: true,
    supportedFormats: ["mp3", "wav", "pcm"],
  };

  return {
    id: "xai",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const apiKey = await resolveXaiApiKey();
      if (!apiKey) {
        throw new XaiTtsError(
          "XAI_TTS_NO_API_KEY",
          "xAI API key not configured. " +
            "Add it via `assistant credentials set --service xai --field api_key <key>` " +
            "or set XAI_API_KEY in your environment / .env.local file.",
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

    async synthesizeStream(
      request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      // Buffered streaming synthesis is a thin wrapper over the persistent
      // session — open a session, push the whole text, finalize. This keeps
      // the WebSocket protocol logic in exactly one place.
      const chunks: Buffer[] = [];
      const session = await openXaiStreamingSession({
        useCase: request.useCase,
        voiceId: request.voiceId,
        outputFormat: request.outputFormat,
        signal: request.signal,
        onChunk: (chunk) => {
          chunks.push(Buffer.from(chunk));
          onChunk(chunk);
        },
      });
      try {
        await session.appendText(request.text);
        await session.finalize();
      } finally {
        await session.close();
      }
      if (chunks.length === 0) {
        throw new XaiTtsError(
          "XAI_TTS_EMPTY_RESPONSE",
          "xAI TTS streaming returned no audio chunks",
        );
      }
      return {
        audio: Buffer.concat(chunks),
        contentType: session.contentType,
      };
    },

    async openStreamingSession(
      options: TtsStreamingSessionOptions,
    ): Promise<TtsStreamingSession> {
      return await openXaiStreamingSession(options);
    },
  };
}

// ---------------------------------------------------------------------------
// Persistent streaming session implementation
// ---------------------------------------------------------------------------

/**
 * Build a request shape from session options so we can reuse the existing
 * codec/voice/sample-rate resolution helpers. The session does not yet have a
 * concrete text payload — that's appended later — but the rest of the
 * request fields are needed up-front to construct the WebSocket URL.
 */
function sessionOptionsToRequest(
  options: TtsStreamingSessionOptions,
): TtsSynthesisRequest {
  return {
    text: "",
    useCase: options.useCase,
    voiceId: options.voiceId,
    outputFormat: options.outputFormat,
    signal: options.signal,
  };
}

async function openXaiStreamingSession(
  options: TtsStreamingSessionOptions,
): Promise<TtsStreamingSession> {
  const apiKey = await resolveXaiApiKey();
  if (!apiKey) {
    throw new XaiTtsError(
      "XAI_TTS_NO_API_KEY",
      "xAI API key not configured. " +
        "Add it via `assistant credentials set --service xai --field api_key <key>` " +
        "or set XAI_API_KEY in your environment / .env.local file.",
    );
  }

  const config = getConfig().services.tts.providers.xai;
  const request = sessionOptionsToRequest(options);
  const output = resolveOutputParams(request, config);
  const voiceId = resolveVoiceId(request, config);
  const url = buildStreamingUrl({ config, output, voiceId });
  const contentType =
    FORMAT_CONTENT_TYPE[output.contentTypeKey] ?? "audio/mpeg";
  const sampleRate = output.sample_rate;

  log.info(
    {
      voiceId,
      codec: output.codec,
      sampleRate,
    },
    "Opening xAI TTS streaming session",
  );

  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new WebSocketWithHeaders(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let finalized = false;
  let closed = false;
  let openResolved = false;

  // Promise that resolves on `open` and rejects on early error/close.
  // All listeners use `{ once: true }` so we never need `removeEventListener`
  // for cleanup — that keeps tests honest against the standard WebSocket API.
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        openResolved = true;
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        if (openResolved) return;
        reject(
          new XaiTtsError(
            "XAI_TTS_REQUEST_FAILED",
            "xAI TTS streaming WebSocket failed to open",
          ),
        );
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (openResolved) return;
        const closeEvent = event as CloseEvent;
        reject(
          new XaiTtsError(
            "XAI_TTS_REQUEST_FAILED",
            `xAI TTS streaming WebSocket closed before open (code=${closeEvent.code}, reason="${closeEvent.reason ?? ""}")`,
          ),
        );
      },
      { once: true },
    );
  });

  // Resolved when xAI emits `audio.done` for the current utterance.
  // Re-created on each finalize so multi-utterance sessions could be added
  // later without re-architecting — for now the session is single-utterance.
  let audioDoneResolve: (() => void) | null = null;
  let audioDoneReject: ((err: Error) => void) | null = null;
  const audioDone = new Promise<void>((resolve, reject) => {
    audioDoneResolve = resolve;
    audioDoneReject = reject;
  });

  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (!data) return;
    let parsed: XaiStreamingEvent;
    try {
      parsed = JSON.parse(data) as XaiStreamingEvent;
    } catch {
      return;
    }
    if (parsed.type === "audio.delta" && typeof parsed.delta === "string") {
      const chunk = Buffer.from(parsed.delta, "base64");
      try {
        options.onChunk(new Uint8Array(chunk));
      } catch {
        // Surface chunk-handler errors via the abort/error path rather than
        // tearing the whole socket — but if onChunk throws we have no way to
        // recover, so just swallow and rely on the caller's signal/close.
      }
      return;
    }
    if (parsed.type === "audio.done") {
      audioDoneResolve?.();
      return;
    }
    if (parsed.type === "error") {
      audioDoneReject?.(
        new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          `xAI TTS streaming error: ${parsed.message ?? "unknown error"}`,
        ),
      );
    }
  });

  socket.addEventListener("close", () => {
    if (!finalized) {
      audioDoneReject?.(
        new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          "xAI TTS streaming WebSocket closed before audio.done",
        ),
      );
    }
    closed = true;
  });

  socket.addEventListener("error", () => {
    if (!finalized) {
      audioDoneReject?.(
        new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          "xAI TTS streaming WebSocket error",
        ),
      );
    }
  });

  if (options.signal) {
    const onAbort = (): void => {
      void session.close();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
  }

  await opened;

  const session: TtsStreamingSession = {
    contentType,
    sampleRate,
    async appendText(text: string): Promise<void> {
      if (finalized) {
        throw new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          "Cannot append text after session has been finalized",
        );
      }
      if (closed) {
        throw new XaiTtsError(
          "XAI_TTS_REQUEST_FAILED",
          "Cannot append text after session has been closed",
        );
      }
      if (text.length === 0) return;
      socket.send(JSON.stringify({ type: "text.delta", delta: text }));
    },
    async finalize(): Promise<void> {
      if (finalized) return;
      finalized = true;
      if (!closed) {
        socket.send(JSON.stringify({ type: "text.done" }));
      }
      await audioDone;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
    },
  };

  return session;
}

function buildStreamingUrl({
  config,
  output,
  voiceId,
}: {
  config: TtsXaiProviderConfig;
  output: XaiOutputParams;
  voiceId: string;
}): string {
  const params = new URLSearchParams({
    language: config.language,
    voice: voiceId,
    codec: output.codec,
    sample_rate: String(output.sample_rate),
    optimize_streaming_latency: XAI_STREAMING_LATENCY_MODE,
  });
  if (output.bit_rate != null) {
    params.set("bit_rate", String(output.bit_rate));
  }
  return `${XAI_TTS_WS_BASE}?${params.toString()}`;
}
