import { describe, expect, test } from "bun:test";

import {
  mulawToPcm16,
  pcm16ToMulaw,
  resamplePcm16,
} from "../calls/media-stream-audio-transcode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pcm16Buffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function readSamples(pcm: Buffer): number[] {
  const samples: number[] = [];
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    samples.push(pcm.readInt16LE(i));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// mulawToPcm16
// ---------------------------------------------------------------------------

describe("mulawToPcm16", () => {
  test("output length is 2x input length", () => {
    const mulaw = new Uint8Array([0xff, 0x7f, 0x00, 0x80, 0x55]);
    const pcm = mulawToPcm16(mulaw);
    expect(pcm.length).toBe(mulaw.length * 2);
  });

  test("empty input decodes to empty output", () => {
    expect(mulawToPcm16(new Uint8Array(0)).length).toBe(0);
  });

  test("mu-law silence (0xFF and 0x7F) decodes to 0", () => {
    const pcm = mulawToPcm16(new Uint8Array([0xff, 0x7f]));
    expect(readSamples(pcm)).toEqual([0, 0]);
  });

  test("round-trip PCM16 -> mu-law -> PCM16 has bounded error", () => {
    const samples = [
      0, 1, -1, 8, -8, 33, -33, 100, -100, 500, -500, 1000, -1000, 4000, -4000,
      8191, -8191, 16000, -16000, 24000, -24000, 32000, -32000, 32635, -32635,
    ];
    const original = pcm16Buffer(samples);
    const decoded = readSamples(mulawToPcm16(pcm16ToMulaw(original)));

    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      // Mu-law quantization error scales with magnitude (~4%), floor of 16.
      const tolerance = Math.max(16, Math.abs(samples[i]) * 0.04);
      expect(Math.abs(decoded[i] - samples[i])).toBeLessThanOrEqual(tolerance);
    }
  });

  test("round-trip preserves sign", () => {
    const original = pcm16Buffer([12345, -12345]);
    const [pos, neg] = readSamples(mulawToPcm16(pcm16ToMulaw(original)));
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeLessThan(0);
    expect(pos).toBe(-neg);
  });
});

// ---------------------------------------------------------------------------
// resamplePcm16
// ---------------------------------------------------------------------------

describe("resamplePcm16", () => {
  test("8k -> 16k doubles the sample count", () => {
    const input = pcm16Buffer([0, 100, 200, 300]);
    const output = resamplePcm16(input, 8000, 16000);
    expect(output.length).toBe(input.length * 2);
  });

  test("8k -> 16k interpolates linearly between samples", () => {
    const output = resamplePcm16(pcm16Buffer([0, 100, 200]), 8000, 16000);
    expect(readSamples(output)).toEqual([0, 50, 100, 150, 200, 200]);
  });

  test("same-rate input is returned unchanged", () => {
    const input = pcm16Buffer([1, -2, 3]);
    const output = resamplePcm16(input, 16000, 16000);
    expect(output).toBe(input);
  });

  test("empty input yields empty output", () => {
    expect(resamplePcm16(Buffer.alloc(0), 8000, 16000).length).toBe(0);
  });

  test("preserves extreme sample values without overflow", () => {
    const output = resamplePcm16(pcm16Buffer([32767, -32768]), 8000, 16000);
    const samples = readSamples(output);
    expect(samples[0]).toBe(32767);
    expect(samples[2]).toBe(-32768);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });

  test("throws on non-positive sample rates", () => {
    expect(() => resamplePcm16(pcm16Buffer([0]), 0, 16000)).toThrow();
    expect(() => resamplePcm16(pcm16Buffer([0]), 8000, -1)).toThrow();
  });
});
