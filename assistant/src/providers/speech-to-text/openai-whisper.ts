import type { SttTranscribeResult } from "../../stt/types.js";

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Derive a filename extension from a MIME type so the Whisper API can detect
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
    const ext = extensionFromMime(mimeType);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mimeType }),
      `audio.${ext}`,
    );
    formData.append("model", "whisper-1");

    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    const response = await fetch(WHISPER_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
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
    return { text: result.text?.trim() ?? "" };
  }
}
