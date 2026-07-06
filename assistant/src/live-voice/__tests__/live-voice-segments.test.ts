import { describe, expect, test } from "bun:test";

import {
  extractSpeakableSegments,
  findSpeakableBoundary,
  LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD,
} from "../live-voice-segments.js";

describe("extractSpeakableSegments", () => {
  test("extracts a sentence at a punctuation boundary and keeps the remainder", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Hello there. Still stream",
      false,
    );

    expect(segments).toEqual(["Hello there."]);
    expect(remainder).toBe(" Still stream");
  });

  test("extracts multiple complete sentences in order", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "First one. Second one! Third one? tail",
      false,
    );

    expect(segments).toEqual(["First one.", "Second one!", "Third one?"]);
    expect(remainder).toBe(" tail");
  });

  test("splits at newlines even without sentence punctuation", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "line one\nline two",
      false,
    );

    expect(segments).toEqual(["line one"]);
    expect(remainder).toBe("line two");
  });

  test("includes trailing quote punctuation in the segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      'She said "stop." Then left',
      false,
    );

    expect(segments).toEqual(['She said "stop."']);
    expect(remainder).toBe(" Then left");
  });

  test("does not split on punctuation inside a word", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "pi is 3.14159 give or take",
      false,
    );

    expect(segments).toEqual([]);
    expect(remainder).toBe("pi is 3.14159 give or take");
  });

  test("buffers short text without a boundary", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Still listening",
      false,
    );

    expect(segments).toEqual([]);
    expect(remainder).toBe("Still listening");
  });

  test("force flush emits the trimmed remainder as a final segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Hello there. Still listening ",
      true,
    );

    expect(segments).toEqual(["Hello there.", "Still listening"]);
    expect(remainder).toBe("");
  });

  test("force flush of whitespace-only text yields no segments", () => {
    const { segments, remainder } = extractSpeakableSegments("   \n  ", true);

    expect(segments).toEqual([]);
    expect(remainder).toBe("");
  });

  test("splits long unpunctuated text conservatively at a whitespace boundary", () => {
    const text = "steady ".repeat(32);
    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.length).toBeGreaterThan(100);
    expect(segment.length).toBeLessThanOrEqual(
      LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD + 1,
    );
    expect(segment.endsWith("steady")).toBe(true);
    expect(text.startsWith(segment)).toBe(true);
    expect(remainder.length).toBeGreaterThan(0);
  });

  test("splits long text without whitespace at the hard threshold", () => {
    const text = "x".repeat(LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD + 40);
    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual([
      "x".repeat(LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD),
    ]);
    expect(remainder).toBe("x".repeat(40));
  });
});

describe("findSpeakableBoundary", () => {
  test("returns the index just past sentence punctuation at end of text", () => {
    expect(findSpeakableBoundary("Done.")).toBe(5);
  });

  test("returns the index just past punctuation followed by whitespace", () => {
    expect(findSpeakableBoundary("Done. More")).toBe(5);
  });

  test("extends past trailing bracket punctuation", () => {
    expect(findSpeakableBoundary("(Done.) More")).toBe(7);
  });

  test("returns null for short text without a boundary", () => {
    expect(findSpeakableBoundary("no boundary here")).toBeNull();
  });

  test("returns the newline boundary before later punctuation", () => {
    expect(findSpeakableBoundary("ab\ncd.")).toBe(3);
  });
});
