import { describe, expect, test } from "bun:test";

import {
  extractMultiSelectLetters,
  mcChoiceMatch,
  mcChoiceSetMatch,
  normPhraseSetMatch,
  normPhraseSetMatchOrdered,
} from "../../judge/deterministic";

describe("normPhraseSetMatch", () => {
  test("matches single phrase contained in prediction", () => {
    expect(
      normPhraseSetMatch("The URL is /settings/project.", "/settings/project"),
    ).toBe(true);
  });

  test("requires every comma-separated phrase to appear", () => {
    expect(normPhraseSetMatch("apple and banana", "apple, banana")).toBe(true);
    expect(normPhraseSetMatch("apple only", "apple, banana")).toBe(false);
  });

  test("order does not matter for the set variant", () => {
    expect(normPhraseSetMatch("banana apple", "apple, banana")).toBe(true);
  });

  test("respects custom separator", () => {
    expect(
      normPhraseSetMatch("apple and banana", "apple|banana", {
        separators: ["|"],
      }),
    ).toBe(true);
  });

  test("requireNonEmpty=true rejects empty prediction", () => {
    expect(normPhraseSetMatch("", "apple")).toBe(false);
  });

  test("requireNonEmpty=false allows empty answer to match anything", () => {
    expect(normPhraseSetMatch("anything", "", { requireNonEmpty: false })).toBe(
      true,
    );
  });

  test("normalization makes hyphenated phrase match prediction with spaces", () => {
    expect(normPhraseSetMatch("project settings", "project-settings")).toBe(
      true,
    );
  });

  test("respects empty separators (single-phrase answer with comma in it)", () => {
    expect(
      normPhraseSetMatch("the count was 12,481 records", "12,481", {
        separators: [],
      }),
    ).toBe(true);
  });
});

describe("normPhraseSetMatchOrdered", () => {
  test("matches when answer phrases appear in order", () => {
    expect(
      normPhraseSetMatchOrdered(
        "click Dashboards, then New, then template, then Save",
        "Dashboards > New > template > Save",
        { separators: [">"] },
      ),
    ).toBe(true);
  });

  test("fails when order is wrong", () => {
    expect(
      normPhraseSetMatchOrdered(
        "click Save, then template, then New, then Dashboards",
        "Dashboards > New > template > Save",
        { separators: [">"] },
      ),
    ).toBe(false);
  });

  test("requireNonEmpty=true rejects empty prediction", () => {
    expect(normPhraseSetMatchOrdered("", "a > b", { separators: [">"] })).toBe(
      false,
    );
  });
});

describe("mcChoiceMatch", () => {
  test("matches single letter regardless of case", () => {
    expect(mcChoiceMatch("a", "A")).toBe(true);
  });

  test("extracts from \\boxed{...}", () => {
    expect(mcChoiceMatch("After thinking, \\boxed{c}", "C")).toBe(true);
  });

  test('strips "choice" and "option" words', () => {
    expect(mcChoiceMatch("Choice B", "B")).toBe(true);
    expect(mcChoiceMatch("Option d.", "D")).toBe(true);
  });

  test("strips trailing periods by default", () => {
    expect(mcChoiceMatch("B.", "B")).toBe(true);
  });

  test("respects custom stripChars", () => {
    expect(mcChoiceMatch("B)", "B", { stripChars: ".)" })).toBe(true);
  });

  test("returns false when letters differ", () => {
    expect(mcChoiceMatch("A", "B")).toBe(false);
  });

  test("null/undefined prediction or answer → false", () => {
    expect(mcChoiceMatch(null, "A")).toBe(false);
    expect(mcChoiceMatch("A", undefined)).toBe(false);
  });
});

describe("mcChoiceSetMatch", () => {
  test("set-equality on multi-letter answers regardless of order", () => {
    expect(mcChoiceSetMatch("A, B, D", "D B A")).toBe(true);
  });

  test('filters filler words like "and"/"option"', () => {
    expect(mcChoiceSetMatch("A and B and C", "A, B, C")).toBe(true);
  });

  test("returns false on different sets", () => {
    expect(mcChoiceSetMatch("A, B", "A, B, C")).toBe(false);
  });

  test("requireNonEmpty=true rejects empty prediction", () => {
    expect(mcChoiceSetMatch("", "A, B")).toBe(false);
  });
});

describe("extractMultiSelectLetters", () => {
  test("explodes a CSV of letters into per-letter array", () => {
    expect(extractMultiSelectLetters("A, B, C")).toEqual(["A", "B", "C"]);
  });

  test("drops filler words", () => {
    expect(extractMultiSelectLetters("Final answer: A and B")).toEqual([
      "A",
      "B",
    ]);
  });

  test("explodes multi-letter chunks like 'BD' into ['B','D']", () => {
    expect(extractMultiSelectLetters("BD")).toEqual(["B", "D"]);
  });
});
