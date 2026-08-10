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
 * Return the mean absolute amplitude of little-endian signed PCM16 audio.
 * Empty buffers return 0, and a trailing odd byte is ignored.
 */
export function pcm16MeanAmplitude(chunk: Buffer): number {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount === 0) {
    return 0;
  }

  let totalAmplitude = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    totalAmplitude += Math.abs(chunk.readInt16LE(i * 2));
  }
  return totalAmplitude / sampleCount;
}

/**
 * Find the strongest normalized correlation between a PCM16 input window and
 * any same-length window in a PCM16 reference. The samples are block-averaged
 * before matching so this stays cheap enough for live audio and remains
 * tolerant of the low-pass filtering introduced by speakers and microphones.
 *
 * The absolute coefficient makes polarity inversion harmless. A flat input or
 * reference has no identifying waveform and returns 0 instead of being treated
 * as a match based on level alone.
 */
export function pcm16MaxNormalizedCorrelation(
  input: Buffer,
  reference: Buffer,
  downsampleFactor = 8,
): number {
  if (!Number.isInteger(downsampleFactor) || downsampleFactor <= 0) {
    return 0;
  }

  let inputSamples = blockAveragePcm16(input, downsampleFactor);
  const referenceSamples = blockAveragePcm16(reference, downsampleFactor);
  if (inputSamples.length > referenceSamples.length) {
    inputSamples = inputSamples.subarray(0, referenceSamples.length);
  }
  if (inputSamples.length < 2) {
    return 0;
  }

  let inputSum = 0;
  for (let index = 0; index < inputSamples.length; index += 1) {
    inputSum += inputSamples[index]!;
  }
  const inputMean = inputSum / inputSamples.length;
  const centeredInput = new Float64Array(inputSamples.length);
  let inputEnergy = 0;
  for (let index = 0; index < inputSamples.length; index += 1) {
    const centered = inputSamples[index]! - inputMean;
    centeredInput[index] = centered;
    inputEnergy += centered * centered;
  }
  if (inputEnergy === 0) {
    return 0;
  }

  const prefixSum = new Float64Array(referenceSamples.length + 1);
  const prefixSquareSum = new Float64Array(referenceSamples.length + 1);
  for (let index = 0; index < referenceSamples.length; index += 1) {
    const sample = referenceSamples[index]!;
    prefixSum[index + 1] = prefixSum[index]! + sample;
    prefixSquareSum[index + 1] = prefixSquareSum[index]! + sample * sample;
  }

  let best = 0;
  const windowLength = inputSamples.length;
  for (
    let offset = 0;
    offset + windowLength <= referenceSamples.length;
    offset += 1
  ) {
    const referenceSum = prefixSum[offset + windowLength]! - prefixSum[offset]!;
    const referenceSquareSum =
      prefixSquareSum[offset + windowLength]! - prefixSquareSum[offset]!;
    const referenceEnergy =
      referenceSquareSum - (referenceSum * referenceSum) / windowLength;
    if (referenceEnergy <= 0) {
      continue;
    }

    let dotProduct = 0;
    for (let index = 0; index < windowLength; index += 1) {
      dotProduct += centeredInput[index]! * referenceSamples[offset + index]!;
    }
    const correlation =
      Math.abs(dotProduct) / Math.sqrt(inputEnergy * referenceEnergy);
    best = Math.max(best, Math.min(correlation, 1));
  }
  return best;
}

function blockAveragePcm16(
  chunk: Buffer,
  downsampleFactor: number,
): Float64Array {
  const sampleCount = Math.floor(chunk.length / 2);
  const blockCount = Math.floor(sampleCount / downsampleFactor);
  const result = new Float64Array(blockCount);
  for (let block = 0; block < blockCount; block += 1) {
    let sum = 0;
    const firstSample = block * downsampleFactor;
    for (let offset = 0; offset < downsampleFactor; offset += 1) {
      sum += chunk.readInt16LE((firstSample + offset) * 2);
    }
    result[block] = sum / downsampleFactor;
  }
  return result;
}

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
  return pcm16MeanAmplitude(chunk) > threshold;
}
