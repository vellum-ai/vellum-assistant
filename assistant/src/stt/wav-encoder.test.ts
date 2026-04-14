import { describe, expect, test } from "bun:test";

import { encodePcm16LeToWav } from "./wav-encoder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default mono 16 kHz PCM16LE options used by most tests. */
const MONO_16K = { sampleRate: 16000, channels: 1 } as const;

/**
 * Read a 4-byte ASCII string from a buffer at the given offset.
 */
function readTag(buf: Buffer, offset: number): string {
  return buf.toString("ascii", offset, offset + 4);
}

// ---------------------------------------------------------------------------
// RIFF / WAVE structure
// ---------------------------------------------------------------------------

describe("encodePcm16LeToWav", () => {
  describe("RIFF/WAVE markers", () => {
    test("starts with RIFF chunk ID", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(readTag(wav, 0)).toBe("RIFF");
    });

    test("contains WAVE format identifier at offset 8", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(readTag(wav, 8)).toBe("WAVE");
    });

    test("contains fmt sub-chunk ID at offset 12", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(readTag(wav, 12)).toBe("fmt ");
    });

    test("contains data sub-chunk ID at offset 36", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(readTag(wav, 36)).toBe("data");
    });
  });

  // -------------------------------------------------------------------------
  // RIFF chunk size
  // -------------------------------------------------------------------------

  describe("RIFF chunk size", () => {
    test("ChunkSize equals fileSize - 8 for non-empty payload", () => {
      const pcm = Buffer.alloc(1024);
      const wav = encodePcm16LeToWav(pcm, MONO_16K);
      const chunkSize = wav.readUInt32LE(4);
      // Total file size = 44 (header) + 1024 (data) = 1068
      // ChunkSize = 1068 - 8 = 1060
      expect(chunkSize).toBe(1068 - 8);
    });

    test("ChunkSize equals 36 for empty payload (header-only)", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      const chunkSize = wav.readUInt32LE(4);
      // Total file size = 44, ChunkSize = 44 - 8 = 36
      expect(chunkSize).toBe(36);
    });
  });

  // -------------------------------------------------------------------------
  // fmt sub-chunk fields
  // -------------------------------------------------------------------------

  describe("fmt sub-chunk", () => {
    test("fmt sub-chunk size is 16 (PCM)", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.readUInt32LE(16)).toBe(16);
    });

    test("AudioFormat is 1 (PCM)", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.readUInt16LE(20)).toBe(1);
    });

    test("NumChannels matches mono input", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 16000,
        channels: 1,
      });
      expect(wav.readUInt16LE(22)).toBe(1);
    });

    test("NumChannels matches stereo input", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 44100,
        channels: 2,
      });
      expect(wav.readUInt16LE(22)).toBe(2);
    });

    test("SampleRate is written correctly for 16 kHz", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.readUInt32LE(24)).toBe(16000);
    });

    test("SampleRate is written correctly for 44.1 kHz", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 44100,
        channels: 1,
      });
      expect(wav.readUInt32LE(24)).toBe(44100);
    });

    test("SampleRate is written correctly for 48 kHz", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 48000,
        channels: 2,
      });
      expect(wav.readUInt32LE(24)).toBe(48000);
    });

    test("ByteRate = sampleRate * channels * bitsPerSample / 8 for mono 16-bit", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      // 16000 * 1 * 16 / 8 = 32000
      expect(wav.readUInt32LE(28)).toBe(32000);
    });

    test("ByteRate = sampleRate * channels * bitsPerSample / 8 for stereo 16-bit", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 48000,
        channels: 2,
      });
      // 48000 * 2 * 16 / 8 = 192000
      expect(wav.readUInt32LE(28)).toBe(192000);
    });

    test("BlockAlign = channels * bitsPerSample / 8 for mono 16-bit", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      // 1 * 16 / 8 = 2
      expect(wav.readUInt16LE(32)).toBe(2);
    });

    test("BlockAlign = channels * bitsPerSample / 8 for stereo 16-bit", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 44100,
        channels: 2,
      });
      // 2 * 16 / 8 = 4
      expect(wav.readUInt16LE(32)).toBe(4);
    });

    test("BitsPerSample defaults to 16", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.readUInt16LE(34)).toBe(16);
    });

    test("BitsPerSample respects explicit override", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 24,
      });
      expect(wav.readUInt16LE(34)).toBe(24);
    });
  });

  // -------------------------------------------------------------------------
  // data sub-chunk
  // -------------------------------------------------------------------------

  describe("data sub-chunk", () => {
    test("data sub-chunk size matches PCM payload length", () => {
      const pcm = Buffer.alloc(512);
      const wav = encodePcm16LeToWav(pcm, MONO_16K);
      expect(wav.readUInt32LE(40)).toBe(512);
    });

    test("data sub-chunk size is 0 for empty payload", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.readUInt32LE(40)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Payload passthrough
  // -------------------------------------------------------------------------

  describe("payload passthrough", () => {
    test("PCM data is copied verbatim after the 44-byte header", () => {
      const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
      const wav = encodePcm16LeToWav(pcm, MONO_16K);

      const payload = wav.subarray(44);
      expect(payload).toEqual(pcm);
    });

    test("large payload is preserved byte-for-byte", () => {
      // 1 second of mono 16 kHz 16-bit audio = 32000 bytes
      const pcm = Buffer.alloc(32000);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = i % 256;
      }

      const wav = encodePcm16LeToWav(pcm, MONO_16K);
      const payload = wav.subarray(44);
      expect(payload).toEqual(pcm);
    });

    test("total file length is header + payload", () => {
      const pcm = Buffer.alloc(256);
      const wav = encodePcm16LeToWav(pcm, MONO_16K);
      expect(wav.length).toBe(44 + 256);
    });
  });

  // -------------------------------------------------------------------------
  // Empty audio (silence / final flush edge case)
  // -------------------------------------------------------------------------

  describe("empty audio", () => {
    test("produces a deterministic 44-byte header-only output", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(wav.length).toBe(44);
    });

    test("header-only output has valid RIFF structure", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(readTag(wav, 0)).toBe("RIFF");
      expect(readTag(wav, 8)).toBe("WAVE");
      expect(readTag(wav, 12)).toBe("fmt ");
      expect(readTag(wav, 36)).toBe("data");
      expect(wav.readUInt32LE(40)).toBe(0);
    });

    test("two calls with empty audio produce identical output", () => {
      const a = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      const b = encodePcm16LeToWav(Buffer.alloc(0), MONO_16K);
      expect(a).toEqual(b);
    });
  });

  // -------------------------------------------------------------------------
  // Custom bit depths
  // -------------------------------------------------------------------------

  describe("custom bit depths", () => {
    test("accepts 8-bit depth and computes correct byte rate", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 8,
      });
      // ByteRate = 8000 * 1 * 8 / 8 = 8000
      expect(wav.readUInt32LE(28)).toBe(8000);
      // BlockAlign = 1 * 8 / 8 = 1
      expect(wav.readUInt16LE(32)).toBe(1);
      expect(wav.readUInt16LE(34)).toBe(8);
    });

    test("accepts 24-bit depth and computes correct byte rate", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 24,
      });
      // ByteRate = 48000 * 2 * 24 / 8 = 288000
      expect(wav.readUInt32LE(28)).toBe(288000);
      // BlockAlign = 2 * 24 / 8 = 6
      expect(wav.readUInt16LE(32)).toBe(6);
      expect(wav.readUInt16LE(34)).toBe(24);
    });

    test("accepts 32-bit depth and computes correct byte rate", () => {
      const wav = encodePcm16LeToWav(Buffer.alloc(0), {
        sampleRate: 44100,
        channels: 1,
        bitsPerSample: 32,
      });
      // ByteRate = 44100 * 1 * 32 / 8 = 176400
      expect(wav.readUInt32LE(28)).toBe(176400);
      // BlockAlign = 1 * 32 / 8 = 4
      expect(wav.readUInt16LE(32)).toBe(4);
      expect(wav.readUInt16LE(34)).toBe(32);
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe("input validation", () => {
    test("throws for zero sample rate", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 0,
          channels: 1,
        }),
      ).toThrow("Invalid sampleRate");
    });

    test("throws for negative sample rate", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: -16000,
          channels: 1,
        }),
      ).toThrow("Invalid sampleRate");
    });

    test("throws for NaN sample rate", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: NaN,
          channels: 1,
        }),
      ).toThrow("Invalid sampleRate");
    });

    test("throws for Infinity sample rate", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: Infinity,
          channels: 1,
        }),
      ).toThrow("Invalid sampleRate");
    });

    test("throws for zero channels", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 16000,
          channels: 0,
        }),
      ).toThrow("Invalid channels");
    });

    test("throws for negative channels", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 16000,
          channels: -1,
        }),
      ).toThrow("Invalid channels");
    });

    test("throws for fractional channels", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 16000,
          channels: 1.5,
        }),
      ).toThrow("Invalid channels");
    });

    test("throws for unsupported bit depth", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 12,
        }),
      ).toThrow("Unsupported bitsPerSample");
    });

    test("throws for zero bit depth", () => {
      expect(() =>
        encodePcm16LeToWav(Buffer.alloc(0), {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 0,
        }),
      ).toThrow("Unsupported bitsPerSample");
    });
  });
});
