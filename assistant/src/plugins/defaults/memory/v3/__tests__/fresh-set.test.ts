import { describe, expect, test } from "bun:test";

import { computeFreshSet } from "../fresh-set.js";

const entry = (slug: string, freshAt: number | null) => ({ slug, freshAt });

describe("computeFreshSet", () => {
  test("ranks by effective recency, newest first", () => {
    const slugs = computeFreshSet(
      [entry("old", 1000), entry("newest", 3000), entry("mid", 2000)],
      { k: 3, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["newest", "mid", "old"]);
  });

  test("an origin-dated import ranks below a recently written page", () => {
    // The imported page's file was written moments ago (its raw mtime is the
    // newest on disk), but its declared origin date is years old, so its
    // freshAt is ancient. The lane ranks on freshAt alone: the recently
    // written page wins.
    const importedFreshAt = Date.parse("2019-03-05");
    const writtenFreshAt = Date.parse("2026-07-29");
    const slugs = computeFreshSet(
      [
        entry("imported-archive", importedFreshAt),
        entry("written-today", writtenFreshAt),
      ],
      { k: 1, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["written-today"]);
  });

  test("cuts to k after exclusions", () => {
    const slugs = computeFreshSet(
      [entry("a", 4000), entry("b", 3000), entry("c", 2000), entry("d", 1000)],
      { k: 2, excludeSlugs: new Set(["a"]) },
    );
    // "a" is excluded BEFORE the cut, so the two slots go to the next-newest.
    expect(slugs).toEqual(["b", "c"]);
  });

  test("skips synthetic entries (freshAt null)", () => {
    const slugs = computeFreshSet(
      [entry("skills/oura", null), entry("real-page", 500)],
      { k: 5, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["real-page"]);
  });

  test("a pre-epoch page is included and ranks below newer pages", () => {
    // 1969-07-20 parses to a negative epoch-ms value. The page must stay in
    // the lane with its declared chronology instead of being dropped or
    // ranked by mtime.
    const preEpoch = Date.parse("1969-07-20");
    expect(preEpoch).toBeLessThan(0);
    const slugs = computeFreshSet(
      [
        entry("apollo-archive", preEpoch),
        entry("written-today", Date.parse("2026-07-29")),
        entry("epoch-day", 0),
      ],
      { k: 3, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["written-today", "epoch-day", "apollo-archive"]);
  });

  test("k = 0 disables the lane", () => {
    expect(
      computeFreshSet([entry("a", 1000)], { k: 0, excludeSlugs: new Set() }),
    ).toEqual([]);
  });

  test("breaks effective-recency ties by slug, ascending", () => {
    const slugs = computeFreshSet(
      [entry("zebra", 1000), entry("apple", 1000), entry("mango", 1000)],
      { k: 3, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["apple", "mango", "zebra"]);
  });

  test("does not mutate the input array", () => {
    const entries = [entry("b", 1000), entry("a", 2000)];
    computeFreshSet(entries, { k: 2, excludeSlugs: new Set() });
    expect(entries.map((e) => e.slug)).toEqual(["b", "a"]);
  });
});
