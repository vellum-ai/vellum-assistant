/**
 * Cheap voiced-speech test for linear PCM16 audio: is this waveform repeating
 * at a pitch period, or is it just loud?
 *
 * ## Why energy alone is not enough
 *
 * `speech-energy.ts` answers "is this louder than the gate", and
 * `room-noise-floor.ts` moves that gate up in a room whose background is
 * loud. Neither asks what the sound *is*. A door slam, a keyboard clack, a
 * bark, a bag dropped on a desk: all clear any gate an ordinary talking voice
 * also clears, because they are as loud as speech. The noise floor cannot help
 * here, because it measures the *continuous* part of a room and these are
 * transients: brief, loud, and gone before a floor could rise to meet them.
 *
 * ## Why periodicity, and not brightness
 *
 * The property that separates a voice from a thud is not level and not
 * spectral tilt. It is repetition. Voiced speech is produced by the vocal
 * folds opening and closing 70-350 times a second, so the waveform repeats
 * itself at the pitch period, and a copy of it delayed by one period lines up
 * with the original almost exactly. Nothing else in a room does that: an
 * impulse has no second copy of itself to line up with, and broadband noise
 * lines up with a delayed copy of itself no better than chance.
 *
 * Zero-crossing rate and band-energy ratio were the cheaper candidates, and
 * both fail on the specific noises being complained about. Each is really a
 * measure of *brightness*, and impulsive room noise is not bright: a door
 * slam, a footstep, and a desk thump are all low-frequency dominated, so they
 * score exactly like a vowel on either test. Spectral flatness does capture
 * the right idea, but reaching it honestly means a spectrum, and a spectrum
 * means an FFT on every chunk of a live call.
 *
 * ## What this deliberately does not separate
 *
 * Periodicity is a test for "something is vibrating at a steady rate", not for
 * "a person is talking". A dog's bark, a smoke alarm, a musical note, a
 * television, and a resonant thud that rings inside the searched pitch band
 * all repeat, and all read as voiced here. Sustained *aperiodic* noise is the
 * class this rules out: typing, rustling, running water, fans, chair scrapes,
 * road noise. That is the class the energy gate is worst at and that a noise
 * floor cannot reach, so it is the useful half to take.
 *
 * A chunk also has to be long enough to contain two pitch periods before there
 * is anything to measure, roughly 30 ms. Shorter framing is reported as
 * unmeasurable rather than guessed at.
 *
 * ## Cost
 *
 * The signal is block-averaged down to about 4 kHz first, which is both the
 * anti-alias filter and the reason the search is cheap: pitch lives far below
 * 4 kHz, so nothing that matters is thrown away, and the correlation then runs
 * over ~47 candidate lags of a few hundred samples each, on the order of
 * 15k multiply-adds for a 100 ms chunk. Low-passing also helps the measurement
 * itself, by taking the fricative-band energy that muddies the correlation out
 * of it before the search.
 *
 * Pure and transport-neutral: a buffer in, a number out, no session state.
 */

/**
 * Lowest and highest fundamental frequency searched. The range spans a deep
 * male voice to a child's, with margin at both ends: a pitch outside the
 * searched band reads as unvoiced, so the band errs wide.
 */
export const PERIODICITY_MIN_PITCH_HZ = 70;
export const PERIODICITY_MAX_PITCH_HZ = 350;

/**
 * Rate the signal is decimated to before the lag search. Above this there is
 * no pitch information to find, only cost.
 */
export const PERIODICITY_ANALYSIS_RATE_HZ = 4_000;

/**
 * Normalized-autocorrelation peak at or above which a chunk counts as voiced.
 *
 * On synthetic 50 ms frames a harmonic vowel scores 0.99 whatever its pitch or
 * level, the same vowel under equal-power broadband noise about 0.8, white
 * noise 0.1-0.25, a shaped fricative 0.13, and a run of key clicks 0.01. The
 * cutoff sits in the gap, nearer the noise end than the middle: reading noise
 * as voiced only leaves today's behaviour in place, while reading a voice as
 * noise takes the user's interruption away from them.
 */
export const DEFAULT_VOICED_PERIODICITY = 0.4;

/**
 * Peak normalized autocorrelation over the pitch lag range, in `[0, 1]`, or
 * `null` when the chunk cannot be judged.
 *
 * `null` means "too short to contain two pitch periods", or "no waveform at
 * all" (silence, or a DC-constant buffer). It is a distinct answer from a low
 * score, and callers must not read it as evidence of noise: a chunk that
 * could not be measured has said nothing about itself.
 *
 * Only positive correlation counts. A voice lines up *in phase* with itself
 * one period later; a strong negative correlation is a half-period alignment,
 * which is not evidence of a period at that lag.
 */
export function pcm16Periodicity(
  chunk: Buffer,
  sampleRate: number,
): number | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }
  const decimation = Math.max(
    1,
    Math.floor(sampleRate / PERIODICITY_ANALYSIS_RATE_HZ),
  );
  const analysisRate = sampleRate / decimation;
  const minLag = Math.max(
    1,
    Math.floor(analysisRate / PERIODICITY_MAX_PITCH_HZ),
  );
  const maxLag = Math.ceil(analysisRate / PERIODICITY_MIN_PITCH_HZ);
  if (minLag >= maxLag) {
    return null;
  }

  const samples = decimatePcm16(chunk, decimation);
  // Two periods at the lowest searched pitch. One period is a coincidence;
  // two is the shortest window in which "this repeats" means anything.
  if (samples.length < maxLag * 2) {
    return null;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index]!;
  }
  const mean = sum / samples.length;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = samples[index]! - mean;
  }

  // Running energy from the tail, so each lag's two window energies come out
  // of a lookup rather than a second pass over the samples.
  const suffixEnergy = new Float64Array(samples.length + 1);
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    suffixEnergy[index] = suffixEnergy[index + 1]! + sample * sample;
  }
  if (suffixEnergy[0]! <= 0) {
    return null;
  }

  let best = 0;
  const searchMaxLag = Math.min(maxLag, samples.length - minLag);
  for (let lag = minLag; lag <= searchMaxLag; lag += 1) {
    const overlap = samples.length - lag;
    let dotProduct = 0;
    for (let index = 0; index < overlap; index += 1) {
      dotProduct += samples[index]! * samples[index + lag]!;
    }
    if (dotProduct <= 0) {
      continue;
    }
    const headEnergy = suffixEnergy[0]! - suffixEnergy[overlap]!;
    const tailEnergy = suffixEnergy[lag]!;
    if (headEnergy <= 0 || tailEnergy <= 0) {
      continue;
    }
    const correlation = dotProduct / Math.sqrt(headEnergy * tailEnergy);
    if (correlation > best) {
      best = correlation;
    }
  }
  return Math.min(best, 1);
}

/**
 * Whether a chunk looks like voiced speech.
 *
 * A chunk that cannot be measured counts as voiced. Every caller here is
 * deciding whether to *withhold* something the user asked for, so an
 * unmeasurable chunk must not be the reason it is withheld.
 */
export function isPcm16Voiced(
  chunk: Buffer,
  sampleRate: number,
  threshold: number = DEFAULT_VOICED_PERIODICITY,
): boolean {
  const periodicity = pcm16Periodicity(chunk, sampleRate);
  return periodicity === null || periodicity >= threshold;
}

/** Block-average `chunk` down by `decimation`, as centered Float64 samples. */
function decimatePcm16(chunk: Buffer, decimation: number): Float64Array {
  const sampleCount = Math.floor(chunk.length / 2);
  const blockCount = Math.floor(sampleCount / decimation);
  const result = new Float64Array(blockCount);
  for (let block = 0; block < blockCount; block += 1) {
    let sum = 0;
    const firstSample = block * decimation;
    for (let offset = 0; offset < decimation; offset += 1) {
      sum += chunk.readInt16LE((firstSample + offset) * 2);
    }
    result[block] = sum / decimation;
  }
  return result;
}

/**
 * What fraction of the most recent stretch of speech looked voiced.
 *
 * ## Why a fraction rather than a verdict per chunk
 *
 * Real words contain unvoiced stretches. The `s` in "stop", the `sh` in
 * "shush", the burst of a `t`: these are turbulence, not vibration, and they
 * score like noise because acoustically they *are* noise. Judging chunk by
 * chunk would throw away the front of a word to save the middle of it. So the
 * question asked is not "was this chunk voiced" but "did this stretch of sound
 * contain a voice at all", which every word does and no thud does.
 *
 * ## Why a trailing window rather than the whole run
 *
 * Some noises do not stop. A blender, a hand dryer, a passing truck can hold
 * the microphone above the gate for seconds at a time. Measured over the whole
 * run, such a noise accumulates unvoiced time without limit, and by the time
 * the user speaks over it their voice is a rounding error against a denominator
 * that has been growing since the noise started: they would be unable to
 * interrupt at all, which is a worse bug than the one being fixed. A window
 * that only remembers the last stretch of speech cannot be poisoned this way.
 * It answers about the sound happening *now*.
 */
export class VoicedSpeechWindow {
  private readonly windowMs: number;
  /** Retained observations, oldest first. */
  private readonly entries: { ms: number; voiced: boolean }[] = [];
  private totalMs = 0;
  private voicedMs = 0;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Record one chunk of above-gate audio and its voiced verdict. */
  observe(durationMs: number, voiced: boolean): void {
    if (!(durationMs > 0) || !Number.isFinite(durationMs)) {
      return;
    }
    this.entries.push({ ms: durationMs, voiced });
    this.totalMs += durationMs;
    if (voiced) {
      this.voicedMs += durationMs;
    }
    this.trim();
  }

  /**
   * Voiced share of the retained window, in `[0, 1]`.
   *
   * An empty window reports 1: nothing has been measured, so nothing has been
   * measured against the user.
   */
  get voicedFraction(): number {
    if (this.totalMs <= 0) {
      return 1;
    }
    return this.voicedMs / this.totalMs;
  }

  /** Forget everything, e.g. when the run it was measuring resets. */
  reset(): void {
    this.entries.length = 0;
    this.totalMs = 0;
    this.voicedMs = 0;
  }

  /**
   * Drop audio that has aged out of the window, splitting the oldest entry
   * rather than discarding it whole. Chunk boundaries are the client's
   * business, so a window that could only end on one would be as long as the
   * client's framing happened to make it.
   */
  private trim(): void {
    while (this.totalMs > this.windowMs && this.entries.length > 0) {
      const oldest = this.entries[0]!;
      const excess = this.totalMs - this.windowMs;
      if (oldest.ms > excess) {
        oldest.ms -= excess;
        this.totalMs -= excess;
        if (oldest.voiced) {
          this.voicedMs -= excess;
        }
        return;
      }
      this.entries.shift();
      this.totalMs -= oldest.ms;
      if (oldest.voiced) {
        this.voicedMs -= oldest.ms;
      }
    }
  }
}
