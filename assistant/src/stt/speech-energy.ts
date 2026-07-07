/**
 * Lightweight energy-based speech activity detector for linear PCM16 audio.
 *
 * The PCM16 analog of the telephony mu-law energy gate
 * (`detectSpeechActivity` in `calls/media-stream-stt-session.ts`): both
 * compute the mean absolute amplitude on the 16-bit linear scale and
 * compare it against the same threshold. Intended to feed
 * `MediaTurnDetector.onMediaChunk(hasSpeech)` for transports that carry
 * raw PCM16 instead of mu-law (e.g. in-app live voice).
 *
 * Transport-neutral: pure buffer analysis, no session or provider state.
 */

/**
 * Mean-absolute-amplitude threshold above which a chunk is classified as
 * speech. Same 16-bit linear scale as the telephony gate, where typical
 * silence averages ~200-400 and speech >1200.
 */
export const DEFAULT_SPEECH_ENERGY_THRESHOLD = 800;

/**
 * Detect speech activity in a chunk of little-endian signed 16-bit mono
 * PCM samples.
 *
 * Computes the mean absolute sample amplitude and compares it against the
 * threshold. Returns `false` for empty buffers. A trailing odd byte is
 * ignored — client chunk boundaries are arbitrary.
 *
 * @param chunk - Raw PCM16LE audio.
 * @param threshold - Mean-amplitude cutoff on the 16-bit linear scale.
 * @returns `true` if the chunk likely contains speech, `false` otherwise.
 */
export function detectPcm16SpeechActivity(
  chunk: Buffer,
  threshold = DEFAULT_SPEECH_ENERGY_THRESHOLD,
): boolean {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount === 0) {
    return false;
  }

  let totalAmplitude = 0;
  for (let i = 0; i < sampleCount; i++) {
    totalAmplitude += Math.abs(chunk.readInt16LE(i * 2));
  }
  const avgAmplitude = totalAmplitude / sampleCount;

  return avgAmplitude > threshold;
}
