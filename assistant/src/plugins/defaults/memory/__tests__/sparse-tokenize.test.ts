import { describe, expect, test } from "bun:test";

import { tokenize, tokenizeStemmed } from "../sparse-tokenize.js";

describe("tokenize", () => {
  test("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  test("preserves alphanumeric runs as-is (no stemming)", () => {
    expect(tokenize("running supplements taking")).toEqual([
      "running",
      "supplements",
      "taking",
    ]);
  });

  test("handles Unicode letters and digits", () => {
    expect(tokenize("café-99 naïve")).toEqual(["café", "99", "naïve"]);
  });

  test("returns empty array for empty / whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\t  ")).toEqual([]);
  });
});

describe("tokenizeStemmed", () => {
  test("collapses plurals to their singular stem", () => {
    expect(tokenizeStemmed("supplements")).toEqual(["supplement"]);
    expect(tokenizeStemmed("tests")).toEqual(["test"]);
  });

  test("collapses verb tenses and gerunds to a shared stem", () => {
    expect(tokenizeStemmed("taking")).toEqual(["take"]);
    expect(tokenizeStemmed("running")).toEqual(["run"]);
    expect(tokenizeStemmed("testing")).toEqual(["test"]);
  });

  test("singular forms map to themselves (idempotent on stems)", () => {
    expect(tokenizeStemmed("supplement")).toEqual(["supplement"]);
    expect(tokenizeStemmed("run")).toEqual(["run"]);
  });

  test("query and document forms collapse to identical buckets", () => {
    // Plural query terms must land on the same stem as singular doc terms
    // (and vice versa). This is the property the BM25 sparse channel
    // relies on so doc-side weights and query-side occurrences match.
    const queryTokens = tokenizeStemmed("filing reports");
    const docTokens = tokenizeStemmed("filed a report");
    expect(queryTokens).toContain("file");
    expect(queryTokens).toContain("report");
    expect(docTokens).toContain("file");
    expect(docTokens).toContain("report");
  });

  test("returns empty array for empty input", () => {
    expect(tokenizeStemmed("")).toEqual([]);
  });

  test("preserves token order and length (one stem per token)", () => {
    const original = tokenize("the quick brown foxes were jumping");
    const stemmed = tokenizeStemmed("the quick brown foxes were jumping");
    expect(stemmed.length).toBe(original.length);
  });
});
