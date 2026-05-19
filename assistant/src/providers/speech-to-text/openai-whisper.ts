import type { SttTranscribeResult } from "../../stt/types.js";

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default conversational priming prompt. The Whisper API treats `prompt`
 * as a soft bias on the decoder's token distribution. Anchoring the model
 * in a "live voice assistant" context discourages the well-known YouTube
 * caption hallucinations ("Thank you for watching", "Please subscribe",
 * "Goodbye.") that `whisper-1` produces on short or low-energy audio.
 *
 * Must be in the same language as the configured `language` param.
 */
const DEFAULT_WHISPER_PROMPT =
  "The user is having a natural conversation with their voice assistant. " +
  "They may pause, hesitate, or speak softly.";

/**
 * Phrases `whisper-1` confidently emits when the audio is silent,
 * near-silent, or too short to transcribe. These are training-set
 * artifacts (overwhelmingly YouTube boilerplate). When the entire
 * trimmed transcript matches one of these phrases we treat it as
 * silence rather than letting it propagate downstream.
 *
 * The list is intentionally narrow: only single utterances that have
 * no plausible meaning in a one-on-one voice-assistant turn. Phrases
 * like "thank you" can be legitimate when they appear inside a longer
 * sentence, so the filter only fires on short, exact, isolated matches.
 */
const KNOWN_WHISPER_HALLUCINATION_PHRASES = new Set([
  "thank you",
  "thank you.",
  "thank you!",
  "thanks",
  "thanks.",
  "thanks!",
  "thank you for watching",
  "thanks for watching",
  "thanks for watching!",
  "thank you so much for watching",
  "thank you for watching this video",
  "thank you for your time",
  "thank you for listening",
  "thanks for listening",
  "see you next time",
  "see you in the next video",
  "see you next video",
  "bye",
  "bye.",
  "bye!",
  "bye bye",
  "bye-bye",
  "goodbye",
  "goodbye.",
  "goodbye!",
  "please subscribe",
  "subscribe to my channel",
  "like and subscribe",
  "like, share, and subscribe",
  "you",
  "yeah",
  "okay",
  "ok",
  ".",
]);

/**
 * Upper bound on transcript length that's eligible for the hallucination
 * filter. Anything longer is treated as real speech even if it begins
 * with a hallucinated phrase, since the model probably attached real
 * content to it.
 */
const HALLUCINATION_MAX_LEN = 64;

export interface WhisperTranscribeOptions {
  /**
   * BCP-47 / ISO-639-1 language hint passed to Whisper. Pinning the
   * language avoids the model's language-detection step, which is a
   * significant hallucination source on short clips. Pass `null` to
   * omit the parameter and let Whisper auto-detect.
   */
  language?: string | null;
  /**
   * Sampling temperature. Whisper defaults to 0; we mirror that
   * explicitly so the encoder is fully deterministic.
   */
  temperature?: number;
  /**
   * Soft decoder bias. Pass `null` to omit. Must be in the same
   * language as `language`.
   */
  prompt?: string | null;
  /**
   * When true (the default), known-hallucination phrases that comprise
   * the entire transcript are converted to empty strings.
   */
  filterHallucinations?: boolean;
}

/**
 * Returns true when `text` looks like a Whisper hallucination of
 * silence/noise rather than real user speech.
 *
 * Exported for tests and for callers that want to apply the filter
 * outside the transcribe path (e.g. across a session-level cache).
 */
export function isLikelyWhisperHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > HALLUCINATION_MAX_LEN) return false;
  // Normalize to a comparable form: lowercase, collapse whitespace,
  // strip leading/trailing punctuation. We keep an inner-punctuation
  // preserving variant too so "Thank you." and "Thank you" both match.
  const lower = trimmed.toLowerCase();
  if (KNOWN_WHISPER_HALLUCINATION_PHRASES.has(lower)) return true;
  const stripped = lower
    .replace(/^[\s.!?,;:'"\-]+/u, "")
    .replace(/[\s.!?,;:'"\-]+$/u, "");
  return KNOWN_WHISPER_HALLUCINATION_PHRASES.has(stripped);
}

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

/**
 * Build a FormData payload for the Whisper `/v1/audio/transcriptions` endpoint.
 *
 * Shared between the batch provider and the streaming adapter to avoid
 * duplicating request construction logic.
 */
function buildWhisperFormData(
  audio: Buffer,
  mimeType: string,
  options: WhisperTranscribeOptions,
): FormData {
  const ext = extensionFromMime(mimeType);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `audio.${ext}`,
  );
  formData.append("model", "whisper-1");

  const language = options.language === undefined ? "en" : options.language;
  if (language !== null) {
    formData.append("language", language);
  }

  const temperature = options.temperature ?? 0;
  formData.append("temperature", String(temperature));

  const prompt =
    options.prompt === undefined ? DEFAULT_WHISPER_PROMPT : options.prompt;
  if (prompt !== null && prompt.length > 0) {
    formData.append("prompt", prompt);
  }

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
  options: WhisperTranscribeOptions = {},
): Promise<string> {
  const formData = buildWhisperFormData(audio, mimeType, options);

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
  const text = result.text?.trim() ?? "";

  if (
    options.filterHallucinations !== false &&
    isLikelyWhisperHallucination(text)
  ) {
    return "";
  }

  return text;
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
