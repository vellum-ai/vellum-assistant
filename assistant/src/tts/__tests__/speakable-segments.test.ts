import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD,
  extractSpeakableSegments,
} from "../speakable-segments.js";

describe("extractSpeakableSegments", () => {
  test("splits complete sentences and keeps the trailing fragment as remainder", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Hello there. How are you? Still typ",
      false,
    );

    expect(segments).toEqual(["Hello there.", "How are you?"]);
    expect(remainder).toBe(" Still typ");
  });

  test("includes trailing quotes and brackets in the sentence segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      'She said "stop!") And then',
      false,
    );

    expect(segments).toEqual(['She said "stop!")']);
    expect(remainder).toBe(" And then");
  });

  test("does not split at punctuation followed by non-whitespace", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Version 3.5 is out",
      false,
    );

    expect(segments).toEqual([]);
    expect(remainder).toBe("Version 3.5 is out");
  });

  test("treats a newline as a segment boundary", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "First line\nsecond line still going",
      false,
    );

    expect(segments).toEqual(["First line"]);
    expect(remainder).toBe("second line still going");
  });

  test("returns punctuation at end-of-text as a complete segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "All done here.",
      false,
    );

    expect(segments).toEqual(["All done here."]);
    expect(remainder).toBe("");
  });

  test("sub-threshold text without a boundary yields no segments until forced", () => {
    const text = "still waiting for a sentence to finish";

    const unforced = extractSpeakableSegments(text, false);
    expect(unforced.segments).toEqual([]);
    expect(unforced.remainder).toBe(text);

    const forced = extractSpeakableSegments(text, true);
    expect(forced.segments).toEqual([text]);
    expect(forced.remainder).toBe("");
  });

  test("force skips whitespace-only remainders", () => {
    const { segments, remainder } = extractSpeakableSegments("   ", true);

    expect(segments).toEqual([]);
    expect(remainder).toBe("");
  });

  test("over-threshold text splits at the last whitespace before the threshold", () => {
    const text = "steady ".repeat(40);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.length).toBeLessThanOrEqual(
      DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD,
    );
    expect(segment.endsWith("steady")).toBe(true);
    expect(remainder.startsWith("steady")).toBe(true);
    // No text is lost across the split.
    expect(`${segment} ${remainder}`).toBe(text);
  });

  test("over-threshold text without whitespace splits at the threshold exactly", () => {
    const text = "x".repeat(DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD + 20);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual([
      "x".repeat(DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD),
    ]);
    expect(remainder).toBe("x".repeat(20));
  });

  test("charThreshold option overrides the default split length", () => {
    const text = "alpha beta gamma delta epsilon";

    const { segments, remainder } = extractSpeakableSegments(text, false, {
      charThreshold: 12,
    });

    expect(segments).toEqual(["alpha beta", "gamma delta"]);
    expect(remainder).toBe("epsilon");
  });

  test("charThreshold defaulting matches the exported constant", () => {
    const text = "y".repeat(DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD - 1);

    const belowDefault = extractSpeakableSegments(text, false);
    expect(belowDefault.segments).toEqual([]);

    const explicitDefault = extractSpeakableSegments(text, false, {
      charThreshold: DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD,
    });
    expect(explicitDefault.segments).toEqual([]);
  });
});
