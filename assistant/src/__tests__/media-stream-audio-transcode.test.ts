import { describe, expect, test } from "bun:test";

import {
  mulawToPcm16,
  pcm16ToMulaw,
  resamplePcm16,
} from "../calls/media-stream-audio-transcode.js";

/** Build a PCM16 LE buffer from signed sample values. */
function pcm16Buffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

/** Read a PCM16 LE buffer back into an array of signed sample values. */
function readPcm16(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

describe("mulawToPcm16", () => {
  test("output length is 2x the input length", () => {
    const mulaw = Uint8Array.from([0x00, 0x7f, 0x80, 0xff, 0x12]);
    const pcm = mulawToPcm16(mulaw);
    expect(pcm.length).toBe(mulaw.length * 2);
  });

  test("empty input yields empty output", () => {
    expect(mulawToPcm16(new Uint8Array(0)).length).toBe(0);
  });

  test("round-trips PCM16 through pcm16ToMulaw with bounded error", () => {
    // A spread of magnitudes and both signs across the dynamic range.
    const samples = [
      0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000, 30000,
      -30000, 32000, -32000,
    ];
    const original = pcm16Buffer(samples);

    const mulaw = pcm16ToMulaw(original);
    const decoded = readPcm16(mulawToPcm16(mulaw));

    expect(decoded.length).toBe(samples.length);

    // mu-law is lossy; quantization error grows with magnitude. Bound the
    // relative error rather than asserting exact equality.
    decoded.forEach((value, i) => {
      const expected = samples[i]!;
      const error = Math.abs(value - expected);
      // mu-law is logarithmic; quantization step grows with magnitude.
      const tolerance = Math.max(8, Math.abs(expected) * 0.05);
      expect(error).toBeLessThanOrEqual(tolerance);
      // Sign must be preserved (except near zero).
      if (Math.abs(expected) > 256) {
        expect(Math.sign(value)).toBe(Math.sign(expected));
      }
    });
  });
});

describe("resamplePcm16", () => {
  test("8000 -> 8000 is identity", () => {
    const pcm = pcm16Buffer([0, 1000, -1000, 32000, -32000, 5]);
    const out = resamplePcm16(pcm, 8000, 8000);
    expect(out.equals(pcm)).toBe(true);
    // Returns a copy, not the same backing buffer.
    expect(out).not.toBe(pcm);
  });

  test("8000 -> 16000 doubles the sample count", () => {
    const samples = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000];
    const pcm = pcm16Buffer(samples);
    const out = resamplePcm16(pcm, 8000, 16000);
    expect(out.length / 2).toBe(samples.length * 2);
  });

  test("8000 -> 16000 interpolates between source samples", () => {
    const pcm = pcm16Buffer([0, 100]);
    const out = readPcm16(resamplePcm16(pcm, 8000, 16000));
    // First output aligns with the first source sample.
    expect(out[0]).toBe(0);
    // An interpolated sample falls between the two source values.
    const interpolated = out.find((v) => v > 0 && v < 100);
    expect(interpolated).toBeDefined();
  });

  test("rejects non-positive sample rates", () => {
    const pcm = pcm16Buffer([1, 2, 3]);
    expect(() => resamplePcm16(pcm, 0, 16000)).toThrow();
    expect(() => resamplePcm16(pcm, 8000, -1)).toThrow();
  });

  test("empty input yields empty output", () => {
    expect(resamplePcm16(Buffer.alloc(0), 8000, 16000).length).toBe(0);
  });
});
