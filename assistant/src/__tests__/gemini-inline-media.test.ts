import { describe, expect, test } from "bun:test";

import {
  base64ByteLength,
  estimateGeminiAudioTokens,
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  normalizeGeminiAudioMime,
} from "../providers/gemini/inline-media.js";

describe("normalizeGeminiAudioMime", () => {
  test("maps audio/mpeg onto Gemini's audio/mp3 spelling", () => {
    expect(normalizeGeminiAudioMime("audio/mpeg")).toBe("audio/mp3");
  });

  test("passes supported audio types through unchanged", () => {
    for (const mime of [
      "audio/wav",
      "audio/mp3",
      "audio/aiff",
      "audio/aac",
      "audio/ogg",
      "audio/flac",
    ]) {
      expect(normalizeGeminiAudioMime(mime)).toBe(mime);
    }
  });

  test("is case-insensitive and strips parameters", () => {
    expect(normalizeGeminiAudioMime("AUDIO/MPEG")).toBe("audio/mp3");
    expect(normalizeGeminiAudioMime("audio/ogg; codecs=opus")).toBe(
      "audio/ogg",
    );
  });

  test("returns null for types Gemini cannot take inline", () => {
    for (const mime of [
      "audio/x-m4a",
      "audio/mp4",
      "audio/opus",
      "application/pdf",
      "image/png",
      "",
    ]) {
      expect(normalizeGeminiAudioMime(mime)).toBeNull();
    }
  });
});

describe("base64ByteLength", () => {
  test("approximates raw bytes from base64 length", () => {
    // 8 base64 chars → 6 raw bytes
    expect(base64ByteLength("QUJDREVG")).toBe(6);
    expect(base64ByteLength("")).toBe(0);
  });
});

describe("estimateGeminiAudioTokens", () => {
  test("scales with payload size and stays far below the base64-as-text count", () => {
    // ~3 MB of base64 ≈ ~2.25 MB raw ≈ ~140s at 16 KB/s ≈ ~4.5k tokens.
    const data = "A".repeat(3 * 1024 * 1024);
    const tokens = estimateGeminiAudioTokens(base64ByteLength(data));
    expect(tokens).toBeGreaterThan(1_000);
    // Must be a small fraction of the naive base64-length/4 estimate (~786k).
    expect(tokens).toBeLessThan(data.length / 40);
  });

  test("returns zero for empty data", () => {
    expect(estimateGeminiAudioTokens(0)).toBe(0);
  });
});

test("inline audio cap leaves headroom under Gemini's 20 MB request limit", () => {
  expect(GEMINI_MAX_INLINE_AUDIO_BYTES).toBe(12 * 1024 * 1024);
  // Base64 of the cap (~16 MB) must stay under the 20 MB wire limit.
  expect(GEMINI_MAX_INLINE_AUDIO_BYTES * (4 / 3)).toBeLessThan(
    20 * 1024 * 1024,
  );
});
