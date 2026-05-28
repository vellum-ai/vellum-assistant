import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SEPARATORS,
  normalizePhrase,
  splitPhrases,
} from "../../judge/normalize";

describe("normalizePhrase", () => {
  test("lowercases, replaces hyphens/underscores, strips punctuation", () => {
    expect(normalizePhrase("New-Dashboard_Layout!")).toBe(
      "new dashboard layout",
    );
  });

  test("collapses runs of whitespace and trims", () => {
    expect(normalizePhrase("  hello   world  ")).toBe("hello world");
  });

  test("returns empty string for null and undefined", () => {
    expect(normalizePhrase(null)).toBe("");
    expect(normalizePhrase(undefined)).toBe("");
  });

  test("respects opts.lower=false", () => {
    expect(normalizePhrase("AaBb", { lower: false })).toBe("AaBb");
  });

  test("respects opts.normalizeHyphen=false", () => {
    expect(normalizePhrase("a-b_c", { normalizeHyphen: false })).toBe("ab_c");
  });

  test("respects opts.stripPunct=false (preserves non-word non-space)", () => {
    expect(normalizePhrase("hello, world!", { stripPunct: false })).toBe(
      "hello world!",
    );
  });

  test("stringifies non-string input via String()", () => {
    expect(normalizePhrase(42)).toBe("42");
  });
});

describe("splitPhrases", () => {
  test("default separators split on commas and semicolons", () => {
    expect(splitPhrases("foo, bar; baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("empty separators returns a single normalized phrase", () => {
    expect(splitPhrases("12,481", { separators: [] })).toEqual(["12 481"]);
  });

  test("custom separator >", () => {
    expect(
      splitPhrases("Dashboards > New > template > Save", { separators: [">"] }),
    ).toEqual(["dashboards", "new", "template", "save"]);
  });

  test("filters out parts that normalize to empty", () => {
    expect(splitPhrases("foo,,bar")).toEqual(["foo", "bar"]);
  });

  test("null/undefined → empty array", () => {
    expect(splitPhrases(null)).toEqual([]);
    expect(splitPhrases(undefined)).toEqual([]);
  });

  test("DEFAULT_SEPARATORS exports comma and semicolon", () => {
    expect(DEFAULT_SEPARATORS).toEqual([",", ";"]);
  });
});
