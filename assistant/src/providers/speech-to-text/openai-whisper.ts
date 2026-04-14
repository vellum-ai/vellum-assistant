import type { SttTranscribeResult } from "../../stt/types.js";

export const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Derive a filename extension from a MIME type so the Whisper API can detect
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
 * Build a FormData payload for the Whisper `/v1/audio/transcriptions` endpoint.
 *
 * Shared between the batch provider and the streaming adapter to avoid
 * duplicating request construction logic.
 */
export function buildWhisperFormData(
  audio: Buffer,
  mimeType: string,
): FormData {
  const ext = extensionFromMime(mimeType);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `audio.${ext}`,
  );
  formData.append("model", "whisper-1");

  return formData;
}

/**
 * Send audio to the Whisper API and return the transcribed text.
 *
 * Shared helper used by both the batch provider and the streaming adapter.
 */
export async function whisperTranscribe(
  apiKey: string,
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {
  const formData = buildWhisperFormData(audio, mimeType);

  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

  const response = await fetch(WHISPER_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: effectiveSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Whisper API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as { text?: string };
  return result.text?.trim() ?? "";
}

export class OpenAIWhisperProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResult> {
    const text = await whisperTranscribe(this.apiKey, audio, mimeType, signal);
    return { text };
  }
}
