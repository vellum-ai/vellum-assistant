import { describe, expect, test } from "bun:test";

import {
  calculateMaxToolResultChars,
  HARD_MAX_TOOL_RESULT_CHARS,
  isOversizedToolResult,
  MIN_KEEP_CHARS,
  truncateOversizedToolResults,
  truncateToolResultText,
  TRUNCATION_SUFFIX,
} from "../context/tool-result-truncation.js";
import type { ContentBlock, ToolResultContent } from "../providers/types.js";

function hasOrphanedSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolResult(content: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: "test-id",
    content,
  };
}

function makeTextBlock(text: string): ContentBlock {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// truncateToolResultText
// ---------------------------------------------------------------------------

describe("truncateToolResultText", () => {
  test("returns text unchanged when under limit", () => {
    const text = "hello world";
    expect(truncateToolResultText(text, 100)).toBe(text);
  });

  test("truncates text that exceeds limit", () => {
    const text = "a".repeat(10_000);
    const result = truncateToolResultText(text, 5_000);
    expect(result.length).toBeLessThanOrEqual(5_000);
    expect(result).toContain(TRUNCATION_SUFFIX);
  });

  test("preserves at least MIN_KEEP_CHARS", () => {
    const text = "a".repeat(10_000);
    // Ask for a very small limit — the function should still keep MIN_KEEP_CHARS
    const result = truncateToolResultText(text, 100);
    // Content before suffix should be at least MIN_KEEP_CHARS - suffix length
    const contentBeforeSuffix = result.slice(
      0,
      result.indexOf(TRUNCATION_SUFFIX),
    );
    expect(contentBeforeSuffix.length).toBeGreaterThanOrEqual(
      MIN_KEEP_CHARS - TRUNCATION_SUFFIX.length,
    );
  });

  test("finds newline boundary for clean cuts", () => {
    // Build text with newlines, large enough to exceed the maxChars budget
    // so truncation actually kicks in and can snap to a newline.
    const lines = Array.from(
      { length: 1000 },
      (_, i) => `line ${i}: ${"x".repeat(20)}`,
    ).join("\n");
    const maxChars = 5_000;
    const result = truncateToolResultText(lines, maxChars);
    // The content before the suffix should end right before a newline boundary
    const beforeSuffix = result.slice(0, result.indexOf(TRUNCATION_SUFFIX));
    // Because we snap to a newline, the next char in the original should be '\n'
    const nextCharInOriginal = lines[beforeSuffix.length];
    expect(nextCharInOriginal).toBe("\n");
  });

  test("appends truncation suffix", () => {
    const text = "x".repeat(5_000);
    const result = truncateToolResultText(text, 1_000);
    expect(result.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  test("does not append suffix when text fits within effectiveMax (maxChars < MIN_KEEP_CHARS)", () => {
    // When maxChars < MIN_KEEP_CHARS, effectiveMax becomes MIN_KEEP_CHARS.
    // If the text is longer than maxChars but shorter than the cutPoint
    // derived from effectiveMax, sliceEnd covers the full text and nothing
    // is actually removed. The function should return the original text
    // without appending the suffix.
    const maxChars = 100;
    const textLength = MIN_KEEP_CHARS - TRUNCATION_SUFFIX.length - 10;
    const text = "a".repeat(textLength);

    // Sanity: text exceeds maxChars but fits within the effective budget
    expect(text.length).toBeGreaterThan(maxChars);
    expect(text.length).toBeLessThan(MIN_KEEP_CHARS);

    const result = truncateToolResultText(text, maxChars);

    // Should return original text unchanged — no suffix appended
    expect(result).toBe(text);
    expect(result).not.toContain(TRUNCATION_SUFFIX);
  });

  test("does not orphan a UTF-16 surrogate pair at the cut boundary", () => {
    // Regression for the "no low surrogate in string" Anthropic 400 error.
    // Build a string where the cut point lands inside a surrogate pair:
    // 4999 padding chars, then an emoji (2 code units), then enough filler
    // to push the cut inside the pair.
    const EMOJI = "\uD83C\uDF89";
    // maxChars = 5_000, so cutPoint = 5_000 - TRUNCATION_SUFFIX.length.
    // Put the emoji so its high surrogate lands exactly at cutPoint - 1.
    const maxChars = 5_000;
    const cutPoint = maxChars - TRUNCATION_SUFFIX.length;
    // Fill up to cutPoint - 1 with "a"s, then place the emoji so the high
    // surrogate is the character at cutPoint - 1 and the low is at cutPoint.
    const prefix = "a".repeat(cutPoint - 1);
    const text = prefix + EMOJI + "b".repeat(100);
    // Use a long filler with no newlines so lastIndexOf("\n", cutPoint) === -1
    // and the function falls back to cutPoint itself.
    const result = truncateToolResultText(text, maxChars);
    expect(hasOrphanedSurrogate(result)).toBe(false);
    // JSON.stringify must not throw on the result.
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// calculateMaxToolResultChars
// ---------------------------------------------------------------------------

describe("calculateMaxToolResultChars", () => {
  test("scales proportionally with context window", () => {
    const small = calculateMaxToolResultChars(10_000);
    const large = calculateMaxToolResultChars(50_000);
    expect(large).toBeGreaterThan(small);
  });

  test("capped at HARD_MAX_TOOL_RESULT_CHARS for large windows", () => {
    // A huge context window should still be capped.
    const result = calculateMaxToolResultChars(10_000_000);
    expect(result).toBe(HARD_MAX_TOOL_RESULT_CHARS);
  });

  test("returns reasonable value for 180K context window", () => {
    const result = calculateMaxToolResultChars(180_000);
    // 180_000 * 0.3 * 4 = 216_000
    expect(result).toBe(216_000);
  });
});

// ---------------------------------------------------------------------------
// isOversizedToolResult
// ---------------------------------------------------------------------------

describe("isOversizedToolResult", () => {
  test("returns false for small tool results", () => {
    const block = makeToolResult("small content");
    expect(isOversizedToolResult(block, 180_000)).toBe(false);
  });

  test("returns true for oversized tool results", () => {
    const block = makeToolResult("x".repeat(500_000));
    expect(isOversizedToolResult(block, 180_000)).toBe(true);
  });

  test("returns false for non-tool-result blocks (cast safely)", () => {
    const textBlock = makeTextBlock("hello") as unknown as ToolResultContent;
    // A text block has no `.content` string of meaningful length, so it
    // should not be considered oversized. We cast to exercise the function
    // safely even with unexpected input.
    expect(isOversizedToolResult(textBlock, 180_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// truncateOversizedToolResults
// ---------------------------------------------------------------------------

describe("truncateOversizedToolResults", () => {
  const contextWindow = 180_000; // maxChars = 216_000

  test("returns unchanged blocks when nothing is oversized", () => {
    const blocks: ContentBlock[] = [
      makeTextBlock("hello"),
      makeToolResult("short"),
    ];
    const { blocks: result, truncatedCount } = truncateOversizedToolResults(
      blocks,
      contextWindow,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(blocks);
  });

  test("truncates oversized tool results", () => {
    const big = makeToolResult("y".repeat(500_000));
    const { blocks: result, truncatedCount } = truncateOversizedToolResults(
      [big],
      contextWindow,
    );
    expect(truncatedCount).toBe(1);
    const truncated = result[0] as ToolResultContent;
    expect(truncated.content.length).toBeLessThan(500_000);
    expect(truncated.content).toContain(TRUNCATION_SUFFIX);
  });

  test("preserves non-tool-result blocks unchanged", () => {
    const text = makeTextBlock("keep me");
    const big = makeToolResult("z".repeat(500_000));
    const { blocks: result } = truncateOversizedToolResults(
      [text, big],
      contextWindow,
    );
    expect(result[0]).toBe(text); // same reference
  });

  test("reports correct truncatedCount", () => {
    const small = makeToolResult("ok");
    const big = makeToolResult("a".repeat(500_000));
    const { truncatedCount } = truncateOversizedToolResults(
      [small, big],
      contextWindow,
    );
    expect(truncatedCount).toBe(1);
  });

  test("handles multiple oversized results", () => {
    const big1 = makeToolResult("a".repeat(500_000));
    const big2 = makeToolResult("b".repeat(500_000));
    const { blocks: result, truncatedCount } = truncateOversizedToolResults(
      [big1, big2],
      contextWindow,
    );
    expect(truncatedCount).toBe(2);
    for (const b of result) {
      const tr = b as ToolResultContent;
      expect(tr.content).toContain(TRUNCATION_SUFFIX);
    }
  });
});
