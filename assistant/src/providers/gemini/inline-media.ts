/**
 * Shared source of truth for how Gemini ingests inline audio: which MIME types
 * it accepts, how our stored MIME types normalize onto Gemini's spelling, the
 * inline-request size ceiling, and the token cost.
 *
 * Imported by both the Gemini serializer (`client.ts`) and the token estimator
 * (`context/token-estimator.ts`) so the two cannot drift — if they disagreed on
 * which audio is sent inline, the context budgeter would mis-count what
 * actually goes on the wire.
 *
 * Ref: https://ai.google.dev/gemini-api/docs/audio
 *   - Inline-accepted audio: wav, mp3, aiff, aac, ogg, flac
 *   - Inline request size limit: 20 MB total (prompt + system + inline files)
 *   - Audio is billed at ~32 tokens/second
 */

/**
 * Audio MIME types Gemini accepts as inline data, in Gemini's own spelling
 * (the values we emit on the wire). Our upload allowlist stores mp3 as
 * `audio/mpeg`; {@link normalizeGeminiAudioMime} maps that onto `audio/mp3`.
 */
export const GEMINI_INLINE_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
]);

/**
 * Map a stored attachment MIME type onto Gemini's inline-audio spelling, or
 * `null` when Gemini cannot take it inline.
 *
 * m4a (`audio/x-m4a`, `audio/mp4`) and opus are intentionally unsupported:
 * m4a bytes are an MP4 container, not raw AAC, so we must not relabel them as
 * `audio/aac` — they fall through to a text placeholder instead.
 */
export function normalizeGeminiAudioMime(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const remapped = normalized === "audio/mpeg" ? "audio/mp3" : normalized;
  return GEMINI_INLINE_AUDIO_MIME_TYPES.has(remapped) ? remapped : null;
}

/** Raw byte length backing a base64 string (4 base64 chars → 3 bytes). */
export function base64ByteLength(base64Data: string): number {
  return Math.floor((base64Data.length * 3) / 4);
}

/**
 * Max raw bytes of audio we send inline to Gemini. Gemini's total inline
 * request limit is 20 MB and base64 inflates payloads ~33%, so we cap raw
 * audio at ~12 MB (≈16 MB encoded) to leave headroom for the prompt, system
 * instruction, and conversation history. Larger files degrade to a text
 * placeholder (the Gemini Files API is a future enhancement).
 */
export const GEMINI_MAX_INLINE_AUDIO_BYTES = 12 * 1024 * 1024;

/**
 * Gemini bills audio at ~32 tokens/second, NOT by payload size. We don't have
 * the decoded duration at estimate time, so approximate it from byte size
 * assuming ~128 kbps (~16 KB/s) typical compressed audio. This keeps the
 * context budgeter within range instead of the ~170x over-count that treating
 * the base64 payload as text produces. (Uncompressed WAV is under-counted, but
 * the inline size guard caps it at {@link GEMINI_MAX_INLINE_AUDIO_BYTES}.)
 */
const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;
const APPROX_AUDIO_BYTES_PER_SECOND = 16_000;

export function estimateGeminiAudioTokensFromBytes(rawBytes: number): number {
  const approxSeconds = rawBytes / APPROX_AUDIO_BYTES_PER_SECOND;
  return Math.ceil(approxSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND);
}

export function estimateGeminiAudioTokens(base64Data: string): number {
  return estimateGeminiAudioTokensFromBytes(base64ByteLength(base64Data));
}
