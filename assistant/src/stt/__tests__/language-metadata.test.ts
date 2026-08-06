import { describe, expect, test } from "bun:test";

import { normalizeLanguageTag, rankLanguages } from "../language-metadata.js";

describe("normalizeLanguageTag", () => {
  test("lowercases a bare base subtag", () => {
    expect(normalizeLanguageTag("EN")).toBe("en");
  });

  test("strips the region subtag", () => {
    expect(normalizeLanguageTag("en-US")).toBe("en");
  });

  test("handles mixed-case regional tags", () => {
    expect(normalizeLanguageTag("PT-br")).toBe("pt");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeLanguageTag("  hi ")).toBe("hi");
  });

  test("returns empty string for blank input", () => {
    expect(normalizeLanguageTag("")).toBe("");
    expect(normalizeLanguageTag("   ")).toBe("");
  });
});

describe("rankLanguages", () => {
  test("returns empty array for empty input", () => {
    expect(rankLanguages([])).toEqual([]);
  });

  test("ranks by frequency, most frequent first", () => {
    expect(rankLanguages(["es", "en", "en", "en", "es"])).toEqual(["en", "es"]);
  });

  test("breaks ties by first appearance", () => {
    expect(rankLanguages(["hi", "en", "en", "hi"])).toEqual(["hi", "en"]);
  });

  test("counts regional variants toward their base subtag", () => {
    expect(rankLanguages(["en-US", "es", "en", "en-GB"])).toEqual(["en", "es"]);
  });

  test("skips blank tags", () => {
    expect(rankLanguages(["", "  ", "ja"])).toEqual(["ja"]);
  });

  test("accepts any iterable", () => {
    expect(rankLanguages(new Set(["fr", "de"]))).toEqual(["fr", "de"]);
  });
});
