import { describe, expect, test } from "bun:test";

import { wrapPcmAsWav } from "./pcm-player.js";

describe("wrapPcmAsWav", () => {
  test("writes a canonical 44-byte mono PCM16 header for the given rate", () => {
    const pcm = Buffer.alloc(160, 7);
    const wav = wrapPcmAsWav(pcm, 24000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate = rate * 2
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  test("tracks the sample rate the frame declared, not a fixed one", () => {
    expect(wrapPcmAsWav(Buffer.alloc(2), 16000).readUInt32LE(24)).toBe(16000);
    expect(wrapPcmAsWav(Buffer.alloc(2), 44100).readUInt32LE(24)).toBe(44100);
  });
});
