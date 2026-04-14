/**
 * Unit tests for `splitLongTextSegment` — the pure helper that slices a
 * string into Slack-section-sized chunks while preferring natural
 * boundaries (paragraph → newline → sentence → hard slice).
 *
 * `textToSlackBlocks` integration coverage lives in PR 4, once the helper
 * is wired into the caller.
 */

import { describe, expect, test } from "bun:test";

import {
  SLACK_SECTION_MAX_CHARS,
  splitLongTextSegment,
} from "../slack-block-formatting.js";

describe("splitLongTextSegment", () => {
  test("returns single-element array for text under the limit", () => {
    const text = "short message";
    const chunks = splitLongTextSegment(text);
    expect(chunks).toEqual([text]);
  });

  test("returns single-element array for text exactly at the limit", () => {
    const text = "a".repeat(SLACK_SECTION_MAX_CHARS);
    const chunks = splitLongTextSegment(text);
    expect(chunks).toEqual([text]);
  });

  test("splits 5000-char paragraph-only text into ≥ 2 chunks under the limit and reconstructs input", () => {
    // Build enough paragraphs (~50 chars each + "\n\n" separators) to
    // comfortably exceed 5000 chars.
    const paragraphs: string[] = [];
    for (let i = 0; i < 120; i++) {
      paragraphs.push(`Paragraph number ${i} with filler content here.`);
    }
    const text = paragraphs.join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(5000);

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
    }

    // Joining chunks with empty string should recover all non-whitespace
    // content (the helper trims chunk boundaries, so inter-chunk "\n\n"
    // separators may be collapsed). Compare whitespace-stripped.
    const rejoined = chunks.join("").replace(/\s+/g, "");
    const original = text.replace(/\s+/g, "");
    expect(rejoined).toBe(original);
  });

  test("splits on paragraph boundary rather than mid-sentence", () => {
    // Two paragraphs where a paragraph split is available inside the
    // first window. Use maxChars large enough that the first paragraph
    // fits, but both together don't.
    const firstParagraph = "a".repeat(2000);
    const secondParagraph = "b".repeat(2000);
    const text = `${firstParagraph}\n\n${secondParagraph}`;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(firstParagraph);
    expect(chunks[1]).toBe(secondParagraph);
  });

  test("splits text with no paragraph or sentence boundaries via hard slice", () => {
    const text = "x".repeat(10_000);
    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(
      Math.ceil(10_000 / SLACK_SECTION_MAX_CHARS),
    );
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
    }

    // No content lost.
    expect(chunks.join("")).toBe(text);
  });

  test("respects custom maxChars parameter", () => {
    const text = "a".repeat(100);
    const chunks = splitLongTextSegment(text, 30);

    expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(100 / 30));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("prefers sentence boundary when no paragraph or newline is available", () => {
    const sentenceA = "This is sentence A. ".repeat(100); // ~2000 chars
    const sentenceB = "This is sentence B. ".repeat(100); // ~2000 chars
    const text = sentenceA + sentenceB;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
      // Each chunk should end with a period (sentence-aligned split).
      expect(chunk.endsWith(".")).toBe(true);
    }
  });

  test("prefers single newline over sentence boundary when no paragraph is present", () => {
    const lineA = "a".repeat(1500);
    const lineB = "b".repeat(1500);
    const text = `${lineA}\n${lineB}`;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(lineA);
    expect(chunks[1]).toBe(lineB);
  });
});
