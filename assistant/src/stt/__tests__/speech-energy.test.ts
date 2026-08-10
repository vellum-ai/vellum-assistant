import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SPEECH_ENERGY_THRESHOLD,
  detectPcm16SpeechActivity,
  pcm16MaxNormalizedCorrelation,
  pcm16MeanAmplitude,
} from "../speech-energy.js";

/** Build a PCM16LE buffer from an array of sample values. */
function pcm16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], i * 2);
  }
  return buf;
}

describe("detectPcm16SpeechActivity", () => {
  test("silence buffer returns false", () => {
    expect(detectPcm16SpeechActivity(pcm16(new Array(160).fill(0)))).toBe(
      false,
    );
  });

  test("low-level noise below the threshold returns false", () => {
    const samples = Array.from({ length: 160 }, (_, i) =>
      i % 2 === 0 ? 300 : -300,
    );
    expect(detectPcm16SpeechActivity(pcm16(samples))).toBe(false);
  });

  test("loud square wave returns true", () => {
    const samples = Array.from({ length: 160 }, (_, i) =>
      i % 2 === 0 ? 10000 : -10000,
    );
    expect(detectPcm16SpeechActivity(pcm16(samples))).toBe(true);
  });

  test("mean exactly at the threshold returns false; just above returns true", () => {
    const at = pcm16(new Array(100).fill(DEFAULT_SPEECH_ENERGY_THRESHOLD));
    expect(detectPcm16SpeechActivity(at)).toBe(false);

    const above = pcm16(
      new Array(100).fill(DEFAULT_SPEECH_ENERGY_THRESHOLD + 1),
    );
    expect(detectPcm16SpeechActivity(above)).toBe(true);
  });

  test("empty buffer returns false", () => {
    expect(detectPcm16SpeechActivity(Buffer.alloc(0))).toBe(false);
  });

  test("single trailing odd byte returns false without throwing", () => {
    expect(detectPcm16SpeechActivity(Buffer.from([0x7f]))).toBe(false);
  });

  test("odd-length buffer ignores the trailing byte", () => {
    const loud = pcm16(new Array(50).fill(10000));
    const withTrailing = Buffer.concat([loud, Buffer.from([0x01])]);
    expect(detectPcm16SpeechActivity(withTrailing)).toBe(true);
  });

  test("custom threshold is respected", () => {
    const quiet = pcm16(new Array(100).fill(500));
    expect(detectPcm16SpeechActivity(quiet)).toBe(false);
    expect(detectPcm16SpeechActivity(quiet, 400)).toBe(true);
    expect(detectPcm16SpeechActivity(quiet, 500)).toBe(false);
  });
});

describe("pcm16MeanAmplitude", () => {
  test("returns 0 for an empty buffer", () => {
    expect(pcm16MeanAmplitude(Buffer.alloc(0))).toBe(0);
  });

  test("returns the exact mean absolute amplitude", () => {
    expect(pcm16MeanAmplitude(pcm16([1_000, -2_000, 3_000, -4_000]))).toBe(
      2_500,
    );
  });

  test("ignores a trailing odd byte", () => {
    const samples = pcm16([3_000, -3_000]);
    expect(
      pcm16MeanAmplitude(Buffer.concat([samples, Buffer.from([0x01])])),
    ).toBe(3_000);
  });

  test("matches the detector's threshold comparison", () => {
    const chunks = [
      Buffer.alloc(0),
      pcm16([0, 0]),
      pcm16([500, -500]),
      pcm16([DEFAULT_SPEECH_ENERGY_THRESHOLD]),
      pcm16([DEFAULT_SPEECH_ENERGY_THRESHOLD + 1]),
    ];
    for (const chunk of chunks) {
      expect(detectPcm16SpeechActivity(chunk)).toBe(
        pcm16MeanAmplitude(chunk) > DEFAULT_SPEECH_ENERGY_THRESHOLD,
      );
    }
  });
});

describe("pcm16MaxNormalizedCorrelation", () => {
  const wave = (frequency: number, count: number): Buffer =>
    pcm16(
      Array.from({ length: count }, (_, index) =>
        Math.round(
          8_000 * Math.sin((2 * Math.PI * frequency * index) / 16_000),
        ),
      ),
    );

  test("finds a matching waveform at an arbitrary reference offset", () => {
    const input = wave(240, 800);
    const reference = Buffer.concat([wave(410, 400), input, wave(610, 400)]);

    expect(pcm16MaxNormalizedCorrelation(input, reference)).toBeGreaterThan(
      0.99,
    );
  });

  test("is invariant to gain and polarity", () => {
    const inputSamples = Array.from({ length: 800 }, (_, index) =>
      Math.round(5_000 * Math.sin((2 * Math.PI * index) / 83)),
    );
    const inverted = pcm16(inputSamples.map((sample) => -2 * sample));

    expect(
      pcm16MaxNormalizedCorrelation(pcm16(inputSamples), inverted),
    ).toBeGreaterThan(0.99);
  });

  test("rejects an unrelated waveform and flat power", () => {
    expect(
      pcm16MaxNormalizedCorrelation(wave(240, 800), wave(610, 1_600)),
    ).toBeLessThan(0.3);
    expect(
      pcm16MaxNormalizedCorrelation(
        pcm16(new Array(800).fill(3_000)),
        pcm16(new Array(1_600).fill(3_000)),
      ),
    ).toBe(0);
  });
});
