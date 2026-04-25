import type { SttTranscribeResult } from "../../stt/types.js";

const XAI_STT_URL = "https://api.x.ai/v1/stt";
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Derive a filename extension from a MIME type so the xAI STT API can detect
 * the audio format. Falls back to "audio" when the MIME type is unrecognised.
 */
export function extensionFromMime(mimeType: string): string {
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
 * xAI does not require a `model` field. The xAI docs explicitly require the
 * `file` field to be appended LAST in the multipart body, so we only append
 * the file here (no other fields in v1).
 */
function buildXaiFormData(audio: Buffer, mimeType: string): FormData {
  const ext = extensionFromMime(mimeType);

  const formData = new FormData();
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
  signal?: AbortSignal,
): Promise<string> {
  const formData = buildXaiFormData(audio, mimeType);

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

export class XAIProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResult> {
    const text = await xaiTranscribe(this.apiKey, audio, mimeType, signal);
    return { text };
  }
}
