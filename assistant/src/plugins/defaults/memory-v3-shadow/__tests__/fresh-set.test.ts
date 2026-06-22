import { describe, expect, test } from "bun:test";

import { computeFreshSet } from "../fresh-set.js";

const entry = (slug: string, modifiedAt: number) => ({ slug, modifiedAt });

describe("computeFreshSet", () => {
  test("ranks by modification time, newest first", () => {
    const slugs = computeFreshSet(
      [entry("old", 1000), entry("newest", 3000), entry("mid", 2000)],
      { k: 3, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["newest", "mid", "old"]);
  });

  test("cuts to k after exclusions", () => {
    const slugs = computeFreshSet(
      [entry("a", 4000), entry("b", 3000), entry("c", 2000), entry("d", 1000)],
      { k: 2, excludeSlugs: new Set(["a"]) },
    );
    // "a" is excluded BEFORE the cut, so the two slots go to the next-newest.
    expect(slugs).toEqual(["b", "c"]);
  });

  test("skips synthetic entries (modifiedAt 0)", () => {
    const slugs = computeFreshSet(
      [entry("skills/oura", 0), entry("real-page", 500)],
      { k: 5, excludeSlugs: new Set() },
    );
    expect(slugs).toEqual(["real-page"]);
  });

  test("k = 0 disables the lane", () => {
    expect(
      computeFreshSet([entry("a", 1000)], { k: 0, excludeSlugs: new Set() }),
    ).toEqual([]);
  });

  test("breaks modification-time ties by slug, ascending", () => {
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
