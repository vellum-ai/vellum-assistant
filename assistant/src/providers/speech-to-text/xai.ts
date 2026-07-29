import type { SttTranscribeResult } from "../../stt/types.js";

const XAI_STT_URL = "https://api.x.ai/v1/stt";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Derive a filename extension from a MIME type so the xAI STT API can detect
 * the audio format. Falls back to "audio" when the MIME type is unrecognised.
 */
function extensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/flac": "flac",
  };
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return map[base] ?? "audio";
}

/**
 * Build a FormData payload for the xAI `/v1/stt` endpoint.
 *
 * xAI does not require a `model` field. The optional `language` field is a
 * plain language code (e.g. "en", "fr"). The xAI docs explicitly require the
 * `file` field to be appended LAST in the multipart body, so every option
 * field goes in before it.
 */
function buildXaiFormData(
  audio: Buffer,
  mimeType: string,
  language?: string,
): FormData {
  const ext = extensionFromMime(mimeType);

  const formData = new FormData();
  if (language) {
    formData.append("language", language);
  }
  // xAI requires the `file` field to be LAST in the multipart body.
  formData.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `audio.${ext}`,
  );

  return formData;
}

/**
 * Send audio to the xAI STT API and return the transcribed text.
 *
 * xAI returns a richer shape (`{ text, language, duration, words }`) — we only
 * consume `text`.
 */
async function xaiTranscribe(
  apiKey: string,
  audio: Buffer,
  mimeType: string,
  language?: string,
  signal?: AbortSignal,
): Promise<string> {
  const formData = buildXaiFormData(audio, mimeType, language);

  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

  const response = await fetch(XAI_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: effectiveSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `xAI STT error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as { text?: string };
  return result.text?.trim() ?? "";
}

export interface XAIProviderOptions {
  /**
   * Language code (e.g. "en", "fr") forwarded as the `language` form field.
   * Omitted by default; xAI auto-detects the spoken language natively when
   * no hint is given.
   */
  language?: string;
}

/**
 * xAI constructor options implied by a language selection, for spreading
 * into adapter constructor options (the batch adapter and the streaming
 * resolver spread this the same way, mirroring `deepgramLanguageOptions`).
 *
 * `"multi"` is Deepgram's code-switching mode, not a language code, so xAI
 * receives no language for it: the adapter falls back to xAI's native
 * multilingual auto-detection, which needs no hint.
 */
export function xaiLanguageOptions(language: string | undefined): {
  language?: string;
} {
  return language && language !== "multi" ? { language } : {};
}

export class XAIProvider {
  private readonly apiKey: string;
  private readonly language: string | undefined;

  constructor(apiKey: string, options: XAIProviderOptions = {}) {
    this.apiKey = apiKey;
    this.language = options.language;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResult> {
    const text = await xaiTranscribe(
      this.apiKey,
      audio,
      mimeType,
      this.language,
      signal,
    );
    return { text };
  }
}
