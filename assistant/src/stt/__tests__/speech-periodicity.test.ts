import { describe, expect, test } from "bun:test";

import {
  DEFAULT_VOICED_PERIODICITY,
  isPcm16Voiced,
  pcm16Periodicity,
  VoicedSpeechWindow,
} from "../speech-periodicity.js";

const SAMPLE_RATE = 24_000;
/** The web client batches microphone PCM into 50 ms frames. */
const FRAME_MS = 50;

function pcmFrom(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(
      -32_768,
      Math.min(32_767, Math.round(samples[index]!)),
    );
    buffer.writeInt16LE(clamped, index * 2);
  }
  return buffer;
}

function sampleCount(ms: number, sampleRate = SAMPLE_RATE): number {
  return Math.round((sampleRate * ms) / 1_000);
}

/**
 * A vowel-shaped waveform: a fundamental plus a decaying harmonic stack, which
 * is what vocal folds driving a vocal tract actually produce.
 */
function vowelPcm(
  ms: number,
  fundamentalHz = 120,
  amplitude = 6_000,
  sampleRate = SAMPLE_RATE,
): Buffer {
  const harmonics = [1, 0.7, 0.5, 0.35, 0.22, 0.14, 0.08];
  const count = sampleCount(ms, sampleRate);
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let value = 0;
    for (let harmonic = 0; harmonic < harmonics.length; harmonic += 1) {
      value +=
        harmonics[harmonic]! *
        Math.sin(
          (2 * Math.PI * fundamentalHz * (harmonic + 1) * index) / sampleRate,
        );
    }
    samples.push((amplitude * value) / 2);
  }
  return pcmFrom(samples);
}

/** Deterministic uniform noise, so a threshold assertion cannot flake. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };
}

function noisePcm(ms: number, amplitude = 6_000, seed = 7): Buffer {
  const random = makeRandom(seed);
  const count = sampleCount(ms);
  return pcmFrom(Array.from({ length: count }, () => amplitude * random()));
}

/** A single broadband transient followed by silence, i.e. a click. */
function impulsePcm(ms: number, amplitude = 28_000): Buffer {
  const count = sampleCount(ms);
  const samples = new Array<number>(count).fill(0);
  for (let index = 0; index < sampleCount(1); index += 1) {
    samples[index] = amplitude * Math.exp(-index / sampleCount(0.2));
  }
  return pcmFrom(samples);
}

/** Key clicks: short broadband bursts, repeated far apart. */
function keyboardPcm(ms: number): Buffer {
  const random = makeRandom(31);
  const count = sampleCount(ms);
  const samples = new Array<number>(count).fill(0);
  const stride = sampleCount(30);
  const burst = sampleCount(4);
  for (let start = 0; start < count; start += stride) {
    for (let index = 0; index < burst && start + index < count; index += 1) {
      samples[start + index] =
        20_000 * Math.exp(-index / sampleCount(1)) * random();
    }
  }
  return pcmFrom(samples);
}

function mixPcm(...buffers: Buffer[]): Buffer {
  const count = Math.min(...buffers.map((buffer) => buffer.length / 2));
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let value = 0;
    for (const buffer of buffers) {
      value += buffer.readInt16LE(index * 2);
    }
    samples.push(value);
  }
  return pcmFrom(samples);
}

function meanAmplitude(chunk: Buffer): number {
  let total = 0;
  const count = chunk.length / 2;
  for (let index = 0; index < count; index += 1) {
    total += Math.abs(chunk.readInt16LE(index * 2));
  }
  return total / count;
}

describe("pcm16Periodicity", () => {
  test("a vowel scores near 1 at any pitch in the searched band", () => {
    for (const fundamentalHz of [80, 120, 200, 300]) {
      const periodicity = pcm16Periodicity(
        vowelPcm(FRAME_MS, fundamentalHz),
        SAMPLE_RATE,
      );
      expect(periodicity).not.toBeNull();
      expect(periodicity!).toBeGreaterThan(0.9);
    }
  });

  test("level does not move the score", () => {
    // Normalization is what lets a barge-in through the client's echo
    // canceller, which attenuates the near-end voice without reshaping it.
    const loud = pcm16Periodicity(vowelPcm(FRAME_MS, 120, 8_000), SAMPLE_RATE);
    const ducked = pcm16Periodicity(vowelPcm(FRAME_MS, 120, 400), SAMPLE_RATE);
    expect(loud).not.toBeNull();
    expect(ducked).not.toBeNull();
    expect(ducked!).toBeCloseTo(loud!, 2);
  });

  test("broadband noise scores far below a voice at the same loudness", () => {
    const noise = noisePcm(FRAME_MS);
    const vowel = vowelPcm(FRAME_MS, 120, 8_000);
    // The paired control the whole change rests on: same energy, different
    // shape. If these two ever converge the discriminator is doing nothing.
    expect(meanAmplitude(noise)).toBeGreaterThan(meanAmplitude(vowel) * 0.8);
    expect(pcm16Periodicity(noise, SAMPLE_RATE)!).toBeLessThan(
      DEFAULT_VOICED_PERIODICITY,
    );
    expect(pcm16Periodicity(vowel, SAMPLE_RATE)!).toBeGreaterThan(
      DEFAULT_VOICED_PERIODICITY,
    );
  });

  test("an impulse and a run of key clicks score near zero", () => {
    expect(pcm16Periodicity(impulsePcm(FRAME_MS), SAMPLE_RATE)!).toBeLessThan(
      0.3,
    );
    expect(pcm16Periodicity(keyboardPcm(200), SAMPLE_RATE)!).toBeLessThan(0.1);
  });

  test("a voice buried in equal-power noise still reads as a voice", () => {
    // The borderline case, and the one that decides whether someone can
    // interrupt from a noisy room.
    const buried = mixPcm(
      vowelPcm(FRAME_MS, 120, 4_000),
      noisePcm(FRAME_MS, 4_000),
    );
    expect(pcm16Periodicity(buried, SAMPLE_RATE)!).toBeGreaterThan(
      DEFAULT_VOICED_PERIODICITY,
    );
  });

  test("silence and a DC-constant buffer are unmeasurable, not unvoiced", () => {
    const count = sampleCount(FRAME_MS);
    expect(
      pcm16Periodicity(pcmFrom(new Array<number>(count).fill(0)), SAMPLE_RATE),
    ).toBeNull();
    expect(
      pcm16Periodicity(
        pcmFrom(new Array<number>(count).fill(8_000)),
        SAMPLE_RATE,
      ),
    ).toBeNull();
  });

  test("a chunk too short for two pitch periods is unmeasurable", () => {
    // 10 ms cannot hold two cycles of a 70 Hz voice, so there is no repetition
    // to look for and the honest answer is "no opinion".
    expect(pcm16Periodicity(vowelPcm(10), SAMPLE_RATE)).toBeNull();
    expect(pcm16Periodicity(vowelPcm(40), SAMPLE_RATE)).not.toBeNull();
  });

  test("an unusable sample rate is unmeasurable", () => {
    expect(pcm16Periodicity(vowelPcm(FRAME_MS), 0)).toBeNull();
    expect(pcm16Periodicity(vowelPcm(FRAME_MS), Number.NaN)).toBeNull();
  });

  test("the separation holds at every sample rate a client sends", () => {
    for (const sampleRate of [16_000, 24_000, 48_000]) {
      const vowel = vowelPcm(FRAME_MS, 120, 6_000, sampleRate);
      expect(pcm16Periodicity(vowel, sampleRate)!).toBeGreaterThan(0.9);
    }
  });
});

describe("isPcm16Voiced", () => {
  test("classifies a vowel voiced and noise unvoiced", () => {
    expect(isPcm16Voiced(vowelPcm(FRAME_MS), SAMPLE_RATE)).toBe(true);
    expect(isPcm16Voiced(noisePcm(FRAME_MS), SAMPLE_RATE)).toBe(false);
  });

  test("an unmeasurable chunk counts as voiced", () => {
    // The bias that keeps this from ever costing someone an interruption:
    // no evidence is not evidence of noise.
    expect(isPcm16Voiced(vowelPcm(10), SAMPLE_RATE)).toBe(true);
    expect(isPcm16Voiced(noisePcm(10), SAMPLE_RATE)).toBe(true);
    expect(isPcm16Voiced(Buffer.alloc(0), SAMPLE_RATE)).toBe(true);
  });
});

describe("VoicedSpeechWindow", () => {
  test("an empty window has nothing to hold against anyone", () => {
    expect(new VoicedSpeechWindow(250).voicedFraction).toBe(1);
  });

  test("reports the voiced share of the retained audio", () => {
    const window = new VoicedSpeechWindow(200);
    window.observe(50, true);
    window.observe(50, false);
    window.observe(50, false);
    window.observe(50, false);
    expect(window.voicedFraction).toBeCloseTo(0.25, 5);
  });

  test("a word's unvoiced opening does not sink the word", () => {
    // "stop": a long /s/, then the vowel. Judged chunk by chunk the /s/ is
    // noise; judged as a stretch of sound, the word contains a voice.
    const window = new VoicedSpeechWindow(250);
    window.observe(50, false);
    window.observe(50, false);
    window.observe(50, true);
    window.observe(50, true);
    expect(window.voicedFraction).toBeCloseTo(0.5, 5);
  });

  test("noise that never stops cannot dilute the voice that follows it", () => {
    // Ten seconds of a running tap, then someone speaking over it. Measured
    // over the whole run the speech would be a rounding error and the user
    // could never interrupt; the window only remembers the recent stretch.
    const window = new VoicedSpeechWindow(250);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 50) {
      window.observe(50, false);
    }
    expect(window.voicedFraction).toBe(0);

    for (let elapsed = 0; elapsed < 250; elapsed += 50) {
      window.observe(50, true);
    }
    expect(window.voicedFraction).toBe(1);
  });

  test("the oldest entry is split rather than dropped whole", () => {
    // Chunk boundaries are the client's business, so the window must be the
    // length it says it is regardless of how audio is framed.
    const window = new VoicedSpeechWindow(100);
    window.observe(80, true);
    window.observe(60, false);
    // 40 ms of the voiced entry survives against 60 ms of the unvoiced one.
    expect(window.voicedFraction).toBeCloseTo(0.4, 5);
  });

  test("reset forgets the run", () => {
    const window = new VoicedSpeechWindow(250);
    window.observe(100, false);
    expect(window.voicedFraction).toBe(0);
    window.reset();
    expect(window.voicedFraction).toBe(1);
  });

  test("nonsense durations are ignored", () => {
    const window = new VoicedSpeechWindow(250);
    window.observe(0, false);
    window.observe(-10, false);
    window.observe(Number.NaN, false);
    expect(window.voicedFraction).toBe(1);
  });
});
