import { describe, expect, test } from "bun:test";

import { extractSalientTokens, findSalientOverlap } from "../salient-tokens.js";

describe("extractSalientTokens", () => {
  test("capitalized non-stopwords", () => {
    const tokens = extractSalientTokens("Ask Pragun about Devin and Claude");
    expect(tokens.has("Pragun")).toBe(true);
    expect(tokens.has("Devin")).toBe(true);
    expect(tokens.has("Claude")).toBe(true);
    expect(tokens.has("Ask")).toBe(true);
  });

  test("stopwords in caps are excluded", () => {
    const tokens = extractSalientTokens("The And But");
    expect(tokens.has("The")).toBe(false);
    expect(tokens.has("And")).toBe(false);
    expect(tokens.has("But")).toBe(false);
  });

  test("single-char caps are excluded", () => {
    // CAPITALIZED_WORD_RE requires at least 2 chars
    const tokens = extractSalientTokens("I A B");
    expect(tokens.size).toBe(0);
  });

  test("file paths", () => {
    const tokens = extractSalientTokens(
      "Look at /src/memory/graph/foo.ts and ./bar.py",
    );
    expect([...tokens].some((t) => t.includes("src/memory/graph/foo.ts"))).toBe(
      true,
    );
    expect([...tokens].some((t) => t.includes("bar.py"))).toBe(true);
  });

  test("URLs", () => {
    const tokens = extractSalientTokens(
      "Check https://github.com/vellum-ai/vellum-assistant",
    );
    expect(
      [...tokens].some((t) =>
        t.includes("https://github.com/vellum-ai/vellum-assistant"),
      ),
    ).toBe(true);
  });

  test("quoted spans", () => {
    const tokens = extractSalientTokens('Look for "some specific phrase" here');
    expect(tokens.has("some specific phrase")).toBe(true);
  });

  test("PR numbers", () => {
    const tokens = extractSalientTokens("See PR #12345 for context");
    expect(tokens.has("#12345")).toBe(true);
  });

  test("single-digit # is not matched", () => {
    const tokens = extractSalientTokens("item #1");
    expect(tokens.has("#1")).toBe(false);
  });

  test("ticket IDs", () => {
    const tokens = extractSalientTokens("Fix LUM-123 and INT-456");
    expect(tokens.has("LUM-123")).toBe(true);
    expect(tokens.has("INT-456")).toBe(true);
  });

  test("empty string", () => {
    const tokens = extractSalientTokens("");
    expect(tokens.size).toBe(0);
  });

  test("no salient tokens in plain lowercase text", () => {
    const tokens = extractSalientTokens("just a simple message");
    expect(tokens.size).toBe(0);
  });
});

describe("findSalientOverlap", () => {
  test("overlap found", () => {
    const context = new Set(["Devin", "Claude", "/src/foo.ts"]);
    const overlap = findSalientOverlap("Tell Devin about it", context);
    expect(overlap.has("Devin")).toBe(true);
    expect(overlap.size).toBe(1);
  });

  test("no overlap", () => {
    const context = new Set(["Pragun", "Claude"]);
    const overlap = findSalientOverlap("hello world", context);
    expect(overlap.size).toBe(0);
  });

  test("case-insensitive matching", () => {
    const context = new Set(["Devin"]);
    const overlap = findSalientOverlap("i asked devin", context);
    expect(overlap.has("Devin")).toBe(true);
  });

  test("empty context → empty overlap", () => {
    const overlap = findSalientOverlap("anything", new Set());
    expect(overlap.size).toBe(0);
  });

  test("multiple overlaps", () => {
    const context = new Set(["Devin", "Claude", "#12345"]);
    const overlap = findSalientOverlap(
      "Ask Devin and Claude about #12345",
      context,
    );
    expect(overlap.size).toBe(3);
  });
});
