/**
 * Typed client for the platform's managed speech proxy (STT + TTS).
 *
 * Wire contract owned by the platform repo (`managed-speech/stt/transcribe`,
 * `managed-speech/tts/synthesize`). This module is the single boundary
 * translating that contract into typed requests/results — callers never
 * construct these URLs or parse these envelopes themselves.
 */

import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("managed-speech");

/** Server rejects a larger decoded payload with 400 — enforce before encoding. */
export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;

/** Deepgram Aura's hard limit on synthesis input length. */
export const MAX_TTS_TEXT_CHARS = 2000;

export type ManagedSpeechFormat = "mp3" | "wav_8000" | "pcm_16000";

export interface TranscribeInput {
  audio: Uint8Array;
  mimeType: string;
  source?: string;
  signal?: AbortSignal;
}

export interface TranscribeResponse {
  text: string;
  providerId: string;
  model: string;
  durationSeconds: number;
}

export interface SynthesizeInput {
  text: string;
  format: ManagedSpeechFormat;
  signal?: AbortSignal;
}

export interface SynthesizeResponse {
  audio: ArrayBuffer;
  /** Upstream media type reported by the proxy, e.g. `audio/mpeg`. */
  contentType: string;
}

/**
 * Known error codes from the platform's managed-speech error envelope, kept
 * open with `(string & {})` so an unrecognized future code still type-checks
 * instead of breaking callers.
 */
export type ManagedSpeechErrorCode =
  | "invalid_request"
  | "insufficient_balance"
  | "missing_price"
  | "rate_limited"
  | "provider_configuration_error"
  | "provider_unreachable"
  | "upstream_error"
  | (string & {});

export interface ManagedSpeechError {
  code: ManagedSpeechErrorCode;
  detail: string;
  status?: number;
}

export type TranscribeResult =
  | { ok: true; value: TranscribeResponse }
  | { ok: false; error: ManagedSpeechError };

export type SynthesizeResult =
  | { ok: true; value: SynthesizeResponse }
  | { ok: false; error: ManagedSpeechError };

export interface ManagedSpeechClient {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

/**
 * Resolves platform availability plus the assistant ID once and hands back a
 * client closed over both — callers get a single `if (!client)` check for
 * "is managed speech available," mirroring `VellumPlatformClient.create()`'s
 * own nullable-availability pattern rather than layering a second check for
 * a missing assistant ID on top of it.
 */
export async function createManagedSpeechClient(): Promise<ManagedSpeechClient | null> {
  const platformClient = await VellumPlatformClient.create();
  if (!platformClient || !platformClient.platformAssistantId) {
    log.debug(
      "platform client unavailable or missing assistant ID — managed speech disabled",
    );
    return null;
  }

  const assistantId = platformClient.platformAssistantId;
  return {
    transcribe: (input) => transcribe(platformClient, assistantId, input),
    synthesize: (input) => synthesize(platformClient, assistantId, input),
  };
}

async function transcribe(
  platformClient: VellumPlatformClient,
  assistantId: string,
  input: TranscribeInput,
): Promise<TranscribeResult> {
  if (input.audio.byteLength > MAX_STT_AUDIO_BYTES) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        detail: `Audio exceeds the ${MAX_STT_AUDIO_BYTES}-byte managed STT limit (got ${input.audio.byteLength} bytes).`,
      },
    };
  }

  const res = await doFetch(() =>
    platformClient.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/managed-speech/stt/transcribe/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: Buffer.from(input.audio).toString("base64"),
          mimeType: input.mimeType,
          ...(input.source !== undefined ? { source: input.source } : {}),
        }),
        signal: input.signal,
      },
    ),
  );
  if (!res.ok) {
    return res;
  }

  return readBody(
    res.value,
    async (r) => (await r.json()) as TranscribeResponse,
  );
}

async function synthesize(
  platformClient: VellumPlatformClient,
  assistantId: string,
  input: SynthesizeInput,
): Promise<SynthesizeResult> {
  // Code points, not UTF-16 code units — the platform validates and bills
  // with Python len(), so emoji and other non-BMP text must count the same
  // way here or valid 2000-code-point requests get rejected locally.
  const textLength = [...input.text].length;
  if (textLength > MAX_TTS_TEXT_CHARS) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        detail: `Text exceeds the ${MAX_TTS_TEXT_CHARS}-character managed TTS limit (got ${textLength} characters).`,
      },
    };
  }

  const res = await doFetch(() =>
    platformClient.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/managed-speech/tts/synthesize/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.text, format: input.format }),
        signal: input.signal,
      },
    ),
  );
  if (!res.ok) {
    return res;
  }

  return readBody(res.value, async (r) => ({
    audio: await r.arrayBuffer(),
    contentType: r.headers.get("content-type") ?? "",
  }));
}

/**
 * Reads a 2xx response body, mapping mid-stream failures (proxy/network reset
 * after headers) to a typed error so callers never see a rejected promise.
 */
async function readBody<T>(
  res: Response,
  read: (res: Response) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ManagedSpeechError }> {
  try {
    return { ok: true, value: await read(res) };
  } catch (err) {
    log.debug({ err }, "managed speech response body read failed");
    return {
      ok: false,
      error: {
        code: "upstream_error",
        detail: `Reading the managed speech response body failed: ${err instanceof Error ? err.message : String(err)}`,
        status: res.status,
      },
    };
  }
}

/**
 * Shared fetch + error-envelope handling for both endpoints: issues the
 * request, maps network failures and non-2xx responses to `ManagedSpeechError`,
 * and hands back the raw `Response` on success for the caller to read the
 * body its own way (JSON for STT, binary for TTS).
 */
async function doFetch(
  send: () => Promise<Response>,
): Promise<
  { ok: true; value: Response } | { ok: false; error: ManagedSpeechError }
> {
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    log.debug({ err }, "managed speech fetch failed");
    return {
      ok: false,
      error: {
        code: "upstream_error",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (!res.ok) {
    return { ok: false, error: await parseErrorEnvelope(res) };
  }

  return { ok: true, value: res };
}

async function parseErrorEnvelope(res: Response): Promise<ManagedSpeechError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { code?: unknown; detail?: unknown };
    if (typeof body.code === "string" && typeof body.detail === "string") {
      return { code: body.code, detail: body.detail, status: res.status };
    }
  } catch {
    // Non-JSON body (proxy error page, bare 504, etc.) — fall through.
  }

  return {
    code: "upstream_error",
    detail: `Managed speech proxy returned status ${res.status}.`,
    status: res.status,
  };
}
