/**
 * Tests for the working-cue renderer: the framing contract (mono s16le at the
 * requested rate), and the acoustic properties that decide whether the cue
 * reads as a hold tone or as a glitch. The anti-click, no-clipping, and
 * no-DC-offset assertions are the substance here: none of them is visible by
 * reading the output, and all three are audible immediately if they break.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORKING_CUE_SHAPE,
  renderWorkingCuePcm,
  type WorkingCueShape,
} from "../working-cue.js";

// Sample rates a client can ask for on the start frame: the STT-typical rate,
// the TTS-typical one, and full-band.
const SAMPLE_RATES = [16_000, 24_000, 48_000];

// Mirrors FADE_FRACTION in the module under test. Duplicated rather than
// exported because the tests assert the *shape* of the envelope, and reading
// the production constant would let a bad value pass by agreeing with itself.
const FADE_FRACTION = 0.15;

const INT16_PEAK = 32_767;

function samplesOf(pcm: Buffer): number[] {
  const samples: number[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    samples.push(pcm.readInt16LE(offset));
  }
  return samples;
}

function expectedFrameCount(
  sampleRate: number,
  shape: WorkingCueShape,
): number {
  return Math.round((sampleRate * shape.durationMs) / 1_000);
}

describe("renderWorkingCuePcm", () => {
  test.each(SAMPLE_RATES)(
    "at %i Hz emits one s16le frame per sample of the requested duration",
    (sampleRate) => {
      const pcm = renderWorkingCuePcm(sampleRate, DEFAULT_WORKING_CUE_SHAPE);
      const frames = expectedFrameCount(sampleRate, DEFAULT_WORKING_CUE_SHAPE);

      expect(frames).toBeGreaterThan(0);
      // Mono, 2 bytes per sample, no container header of any kind: the echo
      // reference reads these bytes as bare PCM at the session rate.
      expect(pcm.byteLength).toBe(frames * 2);
    },
  );

  test.each(SAMPLE_RATES)(
    "at %i Hz starts and ends at silence so neither edge clicks",
    (sampleRate) => {
      const samples = samplesOf(
        renderWorkingCuePcm(sampleRate, DEFAULT_WORKING_CUE_SHAPE),
      );

      expect(samples[0]).toBe(0);
      expect(samples[samples.length - 1]).toBe(0);

      // Zero endpoints alone would also be satisfied by a waveform that leaps
      // to full amplitude on the second sample, which clicks just as loudly.
      // The ramp has to be gradual, so the first and last millisecond stay far
      // below the peak.
      const oneMs = Math.round(sampleRate / 1_000);
      const ceiling = 0.05 * DEFAULT_WORKING_CUE_SHAPE.gain * INT16_PEAK;
      for (let frame = 0; frame < oneMs; frame++) {
        expect(Math.abs(samples[frame]!)).toBeLessThan(ceiling);
        expect(Math.abs(samples[samples.length - 1 - frame]!)).toBeLessThan(
          ceiling,
        );
      }
    },
  );

  test.each(SAMPLE_RATES)(
    "at %i Hz never exceeds the requested gain",
    (sampleRate) => {
      const samples = samplesOf(
        renderWorkingCuePcm(sampleRate, DEFAULT_WORKING_CUE_SHAPE),
      );
      const peak = Math.round(DEFAULT_WORKING_CUE_SHAPE.gain * INT16_PEAK);

      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(peak);
      }
    },
  );

  test.each(SAMPLE_RATES)(
    "at %i Hz reaches full amplitude inside the sustain",
    (sampleRate) => {
      const samples = samplesOf(
        renderWorkingCuePcm(sampleRate, DEFAULT_WORKING_CUE_SHAPE),
      );
      const peak = Math.round(DEFAULT_WORKING_CUE_SHAPE.gain * INT16_PEAK);

      let loudest = 0;
      let loudestFrame = -1;
      samples.forEach((sample, frame) => {
        if (Math.abs(sample) > loudest) {
          loudest = Math.abs(sample);
          loudestFrame = frame;
        }
      });

      // The envelope must open all the way, otherwise the cue is quieter than
      // the configured gain and the fades are eating the whole tone.
      expect(loudest).toBeGreaterThanOrEqual(0.99 * peak);

      const fadeFrames = Math.floor(samples.length * FADE_FRACTION);
      expect(loudestFrame).toBeGreaterThanOrEqual(fadeFrames);
      expect(loudestFrame).toBeLessThan(samples.length - fadeFrames);
    },
  );

  test.each(SAMPLE_RATES)("at %i Hz carries no DC offset", (sampleRate) => {
    const samples = samplesOf(
      renderWorkingCuePcm(sampleRate, DEFAULT_WORKING_CUE_SHAPE),
    );
    const peak = Math.round(DEFAULT_WORKING_CUE_SHAPE.gain * INT16_PEAK);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    // A nonzero mean is inaudible on its own but shifts the echo reference off
    // centre and eats headroom on whatever mixes the cue with speech.
    expect(Math.abs(mean)).toBeLessThan(peak / 1_000);
  });

  test("is deterministic for a given rate and shape", () => {
    const first = renderWorkingCuePcm(24_000, DEFAULT_WORKING_CUE_SHAPE);
    const second = renderWorkingCuePcm(24_000, DEFAULT_WORKING_CUE_SHAPE);

    expect(first.equals(second)).toBe(true);
  });

  test("honours a shape other than the default", () => {
    const shape: WorkingCueShape = {
      frequencyHz: 440,
      durationMs: 100,
      gain: 0.02,
    };
    const samples = samplesOf(renderWorkingCuePcm(24_000, shape));

    expect(samples).toHaveLength(expectedFrameCount(24_000, shape));
    for (const sample of samples) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(
        Math.round(shape.gain * INT16_PEAK),
      );
    }
  });

  test("clamps an out-of-range gain instead of overflowing int16", () => {
    // Gain becomes a config value, so a bad one has to render quietly wrong
    // rather than throw partway through the buffer.
    const samples = samplesOf(
      renderWorkingCuePcm(24_000, { ...DEFAULT_WORKING_CUE_SHAPE, gain: 4 }),
    );

    for (const sample of samples) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(INT16_PEAK);
    }
  });

  test("renders nothing for a zero-length cue", () => {
    const pcm = renderWorkingCuePcm(24_000, {
      ...DEFAULT_WORKING_CUE_SHAPE,
      durationMs: 0,
    });

    expect(pcm.byteLength).toBe(0);
  });

  test("a cue too short to hold both fades still opens and closes at zero", () => {
    // Two frames leaves one for the attack and one for the release, so the
    // envelope has to degrade to all-fade rather than overlapping itself.
    const samples = samplesOf(
      renderWorkingCuePcm(24_000, {
        ...DEFAULT_WORKING_CUE_SHAPE,
        durationMs: 2 / 24,
      }),
    );

    expect(samples).toHaveLength(2);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(0);
  });
});

describe("DEFAULT_WORKING_CUE_SHAPE", () => {
  test("stays a soft hum well under speech level", () => {
    // Guards the intent of the defaults rather than the exact numbers, which
    // are meant to be retuned by ear.
    expect(DEFAULT_WORKING_CUE_SHAPE.gain).toBeGreaterThan(0);
    expect(DEFAULT_WORKING_CUE_SHAPE.gain).toBeLessThan(0.2);
    expect(DEFAULT_WORKING_CUE_SHAPE.frequencyHz).toBeGreaterThan(80);
    expect(DEFAULT_WORKING_CUE_SHAPE.frequencyHz).toBeLessThan(1_000);
    expect(DEFAULT_WORKING_CUE_SHAPE.durationMs).toBeGreaterThan(0);
    expect(DEFAULT_WORKING_CUE_SHAPE.durationMs).toBeLessThan(1_000);
  });
});
