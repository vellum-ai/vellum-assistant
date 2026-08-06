/**
 * Shared source of truth for how OpenAI-compatible chat-completions providers
 * ingest inline audio: which MIME types map onto the wire `input_audio.format`
 * enum, the inline size cap, and the token-cost heuristic. The provider
 * transform (`chat-completions-provider.ts`) and the context budgeter
 * (`context/token-estimator.ts`) both read these — if they disagreed about
 * which audio is sent inline, the budgeter would mis-count what the provider
 * actually ships.
 *
 * Wire shape (OpenAI chat-completions spec):
 *   { type: "input_audio", input_audio: { data: <base64>, format: "wav"|"mp3" } }
 *
 * m4a/ogg/flac/opus are deliberately absent: the spec's `format` enum is
 * wav|mp3 only. Whether a given model receives audio at all is gated by the
 * catalog `supportsAudioInput` capability (`modelSupportsAudioInput`), not
 * here — this module only decides eligibility of the payload itself.
 */

export type OpenAIInputAudioFormat = "wav" | "mp3";

const MIME_TO_INPUT_AUDIO_FORMAT: ReadonlyMap<string, OpenAIInputAudioFormat> =
  new Map([
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/wave", "wav"],
    ["audio/mpeg", "mp3"],
    ["audio/mp3", "mp3"],
  ]);

/**
 * Map a stored attachment MIME type onto the `input_audio.format` enum, or
 * `null` when the type is not sent inline.
 */
export function openAIInputAudioFormat(
  mimeType: string,
): OpenAIInputAudioFormat | null {
  return MIME_TO_INPUT_AUDIO_FORMAT.get(mimeType.toLowerCase()) ?? null;
}

/**
 * Max raw bytes of audio sent inline. Base64 inflates the payload ~4/3, so
 * 12 MB raw ≈ 16 MB encoded — headroom for the rest of the prompt under
 * typical request-size limits (same rationale as the Gemini inline-audio cap).
 */
export const OPENAI_COMPAT_MAX_INLINE_AUDIO_BYTES = 12 * 1024 * 1024;

/**
 * True when an audio media source of this MIME type and byte length is
 * eligible to be sent inline as an `input_audio` part (given a model whose
 * catalog entry carries `supportsAudioInput`).
 */
export function isOpenAICompatInlineAudio(
  mimeType: string,
  byteLength: number,
): boolean {
  return (
    openAIInputAudioFormat(mimeType) !== null &&
    byteLength <= OPENAI_COMPAT_MAX_INLINE_AUDIO_BYTES
  );
}

/**
 * Audio-native chat-completions models bill audio by duration, not payload
 * size (measured on Baseten's Inkling: ~20 tokens/sec — 127 audio tokens for
 * a 6.3 s clip). Duration is approximated from byte length at compressed-audio
 * rates (~16 KB/s); for uncompressed PCM wavs this overestimates duration and
 * therefore tokens — the safe direction for the compaction pre-check
 * (compact early, never overflow).
 */
const AUDIO_TOKENS_PER_SECOND = 20;
const APPROX_AUDIO_BYTES_PER_SECOND = 16_000;

export function estimateOpenAICompatAudioTokens(byteLength: number): number {
  const approxSeconds = byteLength / APPROX_AUDIO_BYTES_PER_SECOND;
  return Math.ceil(approxSeconds * AUDIO_TOKENS_PER_SECOND);
}
