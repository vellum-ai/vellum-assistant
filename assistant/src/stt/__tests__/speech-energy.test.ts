import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SPEECH_ENERGY_THRESHOLD,
  detectPcm16SpeechActivity,
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
