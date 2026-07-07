import { describe, expect, test } from "bun:test";

import { extractSpeakableSegments } from "../speakable-segments.js";

const DEFAULT_CHAR_THRESHOLD = 180;
const EAGER_CHAR_THRESHOLD = 60;

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

  test("text below the 180-char threshold does not force-split", () => {
    const text = "y".repeat(DEFAULT_CHAR_THRESHOLD - 1);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual([]);
    expect(remainder).toBe(text);
  });

  test("over-threshold text splits at the last whitespace before the threshold", () => {
    const text = "steady ".repeat(40);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.length).toBeLessThanOrEqual(DEFAULT_CHAR_THRESHOLD);
    expect(segment.endsWith("steady")).toBe(true);
    expect(remainder.startsWith("steady")).toBe(true);
    // No text is lost across the split.
    expect(`${segment} ${remainder}`).toBe(text);
  });

  test("over-threshold text without whitespace splits at the threshold exactly", () => {
    const text = "x".repeat(DEFAULT_CHAR_THRESHOLD + 20);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual(["x".repeat(DEFAULT_CHAR_THRESHOLD)]);
    expect(remainder).toBe("x".repeat(20));
  });

  describe("eager mode", () => {
    test("splits at a comma once enough text precedes it", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, I can help with that, and here is more",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Sure, I can help with that,"]);
      expect(remainder).toBe(" and here is more");
    });

    test("splits at semicolons and colons past the prefix floor", () => {
      const { segments } = extractSpeakableSegments(
        "Here is what I found today; there is more coming",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Here is what I found today;"]);
    });

    test("a short clause like 'Sure, ' does not flush on its own", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, ",
        false,
        { eager: true },
      );

      expect(segments).toEqual([]);
      expect(remainder).toBe("Sure, ");
    });

    test("clause punctuation at end-of-text keeps buffering", () => {
      const text = "Sure, I can help with that,";

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });

    test("uses the lower 60-char threshold to split without punctuation", () => {
      const text = "word ".repeat(20);

      const { segments } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments.length).toBeGreaterThan(0);
      const segment = segments[0] ?? "";
      expect(segment.length).toBeLessThanOrEqual(EAGER_CHAR_THRESHOLD);
      expect(segment.endsWith("word")).toBe(true);
    });

    test("eagerness applies only to the first segment of a call", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, I can help with that, and after that we can keep going, with more",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Sure, I can help with that,"]);
      expect(remainder).toBe(
        " and after that we can keep going, with more",
      );
    });

    test("non-eager extraction ignores clause punctuation", () => {
      const text = "Sure, I can help with that, and here is more";

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });
  });

  describe("open inline spans", () => {
    test("does not split at a clause boundary inside an open bold span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "**bold text that keeps going, more** and then.",
        false,
        { eager: true },
      );

      expect(segments).toEqual([
        "**bold text that keeps going, more** and then.",
      ]);
      expect(remainder).toBe("");
    });

    test("does not split at a clause boundary inside an open backtick span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "`code segment with a comma here, x` done.",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["`code segment with a comma here, x` done."]);
      expect(remainder).toBe("");
    });

    test("splits normally at a clause boundary after a balanced span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "He said **wait** and more, then it continued on",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["He said **wait** and more,"]);
      expect(remainder).toBe(" then it continued on");
    });

    test("does not split at sentence punctuation inside an open bold span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "**Wait. No** more.",
        false,
      );

      expect(segments).toEqual(["**Wait. No** more."]);
      expect(remainder).toBe("");
    });

    test("does not split at sentence punctuation inside an open italic span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "*hold on. yes* it is done.",
        false,
      );

      expect(segments).toEqual(["*hold on. yes* it is done."]);
      expect(remainder).toBe("");
    });

    test("an open span still flushes at the length-threshold hard cap", () => {
      const text = `**${"steady ".repeat(40)}`;

      const { segments } = extractSpeakableSegments(text, false);

      expect(segments).toHaveLength(1);
      expect((segments[0] ?? "").length).toBeLessThanOrEqual(
        DEFAULT_CHAR_THRESHOLD,
      );
    });
  });
});
