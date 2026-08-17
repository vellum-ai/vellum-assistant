import { describe, expect, test } from "bun:test";

import {
  dominantLanguageTag,
  rankLanguages,
  voteDominantLanguage,
} from "../language-metadata.js";

describe("voteDominantLanguage", () => {
  test("only the dominance-ranked first entry votes", () => {
    const tally = new Map<string, number>();
    voteDominantLanguage(tally, ["en", "es"]);
    expect(tally.get("en")).toBe(1);
    expect(tally.has("es")).toBe(false);
  });

  test("regional variants count toward their base subtag", () => {
    const tally = new Map<string, number>();
    voteDominantLanguage(tally, ["pt-BR"]);
    voteDominantLanguage(tally, ["pt"]);
    expect(tally.get("pt")).toBe(2);
  });

  test("underscore-separated variants count toward their base subtag", () => {
    const tally = new Map<string, number>();
    voteDominantLanguage(tally, ["hi_IN"]);
    expect(tally.get("hi")).toBe(1);
  });

  test("blank and absent tags cast no vote", () => {
    const tally = new Map<string, number>();
    voteDominantLanguage(tally, undefined);
    voteDominantLanguage(tally, []);
    voteDominantLanguage(tally, ["  "]);
    expect(tally.size).toBe(0);
  });
});

describe("dominantLanguageTag", () => {
  test("most votes wins", () => {
    const tally = new Map([
      ["en", 1],
      ["es", 3],
    ]);
    expect(dominantLanguageTag(tally)).toBe("es");
  });

  test("ties break by first insertion", () => {
    const tally = new Map([
      ["hi", 2],
      ["en", 2],
    ]);
    expect(dominantLanguageTag(tally)).toBe("hi");
  });

  test("undefined for an empty tally", () => {
    expect(dominantLanguageTag(new Map())).toBeUndefined();
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
