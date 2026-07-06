import { describe, expect, test } from "bun:test";

import { detectPcm16SpeechActivity } from "../pcm-speech-activity.js";

/** Encode an array of 16-bit samples as a PCM16-LE buffer. */
function pcm16Buffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], i * 2);
  }
  return buffer;
}

/** Generate a sine wave at the given amplitude (160 samples ≈ 10ms @ 16kHz). */
function sineWave(amplitude: number, sampleCount = 160): Buffer {
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(Math.round(amplitude * Math.sin((2 * Math.PI * i) / 20)));
  }
  return pcm16Buffer(samples);
}

describe("detectPcm16SpeechActivity", () => {
  test("returns false for an all-zero (silent) buffer", () => {
    expect(detectPcm16SpeechActivity(pcm16Buffer(new Array(160).fill(0)))).toBe(
      false,
    );
  });

  test("returns true for a loud sine wave (amplitude ~8000)", () => {
    expect(detectPcm16SpeechActivity(sineWave(8000))).toBe(true);
  });

  test("returns false for quiet noise below the threshold", () => {
    const samples: number[] = [];
    for (let i = 0; i < 160; i++) {
      samples.push(i % 2 === 0 ? 300 : -300);
    }
    expect(detectPcm16SpeechActivity(pcm16Buffer(samples))).toBe(false);
  });

  test("returns false for an empty buffer", () => {
    expect(detectPcm16SpeechActivity(Buffer.alloc(0))).toBe(false);
  });

  test("ignores a trailing odd byte without throwing", () => {
    const loud = sineWave(8000);
    const oddLength = Buffer.concat([loud, Buffer.from([0x7f])]);
    expect(detectPcm16SpeechActivity(oddLength)).toBe(true);

    // A single stray byte has no complete samples → treated as empty.
    expect(detectPcm16SpeechActivity(Buffer.from([0x7f]))).toBe(false);
  });

  test("respects a custom threshold", () => {
    const quiet = pcm16Buffer(new Array(160).fill(500));
    expect(detectPcm16SpeechActivity(quiet)).toBe(false);
    expect(detectPcm16SpeechActivity(quiet, 400)).toBe(true);

    const loud = sineWave(8000);
    expect(detectPcm16SpeechActivity(loud, 20_000)).toBe(false);
  });
});
