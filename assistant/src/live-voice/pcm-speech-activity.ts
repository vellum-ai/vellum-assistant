/**
 * Default energy threshold on the 16-bit linear amplitude scale.
 *
 * Matches the telephony stack's `SPEECH_ENERGY_THRESHOLD` (μ-law decodes to
 * the same 16-bit linear scale), where typical silence averages ~200-400 and
 * speech >1200.
 */
const DEFAULT_SPEECH_ENERGY_THRESHOLD = 800;

/**
 * Lightweight energy-based speech activity detector for PCM16-LE audio.
 *
 * Mirrors the telephony μ-law heuristic in
 * `src/calls/media-stream-stt-session.ts` (`detectSpeechActivity`): compute
 * the average absolute linear amplitude of the chunk's samples and compare
 * it against a threshold. Because μ-law decodes to the same 16-bit linear
 * scale, the same threshold applies to both encodings.
 *
 * The threshold is config-driven via `liveVoice.vad.speechEnergyThreshold`
 * (wired in a later PR).
 *
 * @param chunk - Raw PCM16 little-endian mono audio. A trailing odd byte is
 *   ignored.
 * @param threshold - Energy threshold on the 16-bit linear amplitude scale.
 * @returns `true` if the chunk likely contains speech, `false` otherwise.
 */
export function detectPcm16SpeechActivity(
  chunk: Buffer,
  threshold: number = DEFAULT_SPEECH_ENERGY_THRESHOLD,
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
