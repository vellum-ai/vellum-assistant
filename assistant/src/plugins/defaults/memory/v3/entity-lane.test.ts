import { describe, expect, test } from "bun:test";

import { buildEntityIndex, entityLane } from "./entity-lane.js";
import type { Section, SectionIndex } from "./types.js";

/** Build a minimal {@link SectionIndex} from `(article, title)` pairs. */
function mkIndex(
  pairs: Array<{ article: string; title: string }>,
): SectionIndex {
  const sections: Section[] = pairs.map((p, i) => ({
    article: p.article,
    title: p.title,
    text: `${p.title}\nbody`,
    ordinal: i,
  }));
  const byArticle = new Map<string, number[]>();
  sections.forEach((s, i) => {
    const list = byArticle.get(s.article) ?? [];
    list.push(i);
    byArticle.set(s.article, list);
  });
  return { sections, byArticle };
}

/** Stub `isDistinctive`: only the listed tokens count as entity keys. */
const distinctive =
  (...tokens: string[]) =>
  (token: string) =>
    tokens.includes(token);

describe("buildEntityIndex", () => {
  test("indexes distinctive heading tokens to their sections", () => {
    const index = mkIndex([
      { article: "team-roster", title: "Alice Chen" },
      { article: "team-roster", title: "Bob" },
      { article: "places", title: "The Acme room" },
    ]);
    const entity = buildEntityIndex(
      index,
      distinctive("alice", "chen", "bob", "acme"),
    );
    expect(entity.get("alice")).toEqual([0]);
    expect(entity.get("chen")).toEqual([0]);
    expect(entity.get("bob")).toEqual([1]);
    expect(entity.get("acme")).toEqual([2]);
    // "the"/"room" are not distinctive → not keys.
    expect(entity.has("the")).toBe(false);
    expect(entity.has("room")).toBe(false);
  });

  test("skips lead sections (no heading) and hub tokens", () => {
    const index = mkIndex([
      { article: "company", title: "" }, // lead — no heading
      { article: "company", title: "the team" }, // hub words only
    ]);
    const entity = buildEntityIndex(index, distinctive("alice")); // nothing distinctive here
    expect(entity.size).toBe(0);
  });

  test("a token in several headings maps to all of them in section order", () => {
    const index = mkIndex([
      { article: "a", title: "Alice Chen" },
      { article: "b", title: "Alice's desk" },
    ]);
    const entity = buildEntityIndex(index, distinctive("alice"));
    expect(entity.get("alice")).toEqual([0, 1]);
  });
});

describe("entityLane", () => {
  const index = mkIndex([
    { article: "team-roster", title: "Alice Chen" },
    { article: "side-notes", title: "the weekly bet" }, // names alice in body, not heading
    { article: "places", title: "The Acme room" },
  ]);
  const entity = buildEntityIndex(index, distinctive("alice", "chen", "acme"));

  test("surfaces the heading section for a named entity", () => {
    expect(entityLane(entity, index, "what's up with alice", 8)).toEqual([
      { article: "team-roster", section: 0 },
    ]);
  });

  test("matches a multi-word heading on either distinctive token", () => {
    expect(entityLane(entity, index, "ask chen", 8)).toEqual([
      { article: "team-roster", section: 0 },
    ]);
  });

  test("ignores message words that are not entity headings", () => {
    expect(
      entityLane(entity, index, "we might do a sale, so annoying", 8),
    ).toEqual([]);
  });

  test("dedups to distinct articles and respects the cap", () => {
    const hits = entityLane(entity, index, "alice and the acme room", 1);
    expect(hits.length).toBe(1);
    expect(hits[0]!.article).toBe("team-roster");
  });

  test("cap <= 0 disables the lane", () => {
    expect(entityLane(entity, index, "alice", 0)).toEqual([]);
  });

  test("ranks multi-token headings first so a common first name can't starve the exact page", () => {
    // The exact "Alice Chen" page is LAST in section order; many "Alice …" pages
    // precede it. Section-order truncation would drop it at a small cap — overlap
    // ranking keeps it because its heading matches both "alice" and "chen".
    const roster = mkIndex([
      { article: "alice-smith", title: "Alice Smith" },
      { article: "alice-jones", title: "Alice Jones" },
      { article: "alice-park", title: "Alice Park" },
      { article: "alice-chen", title: "Alice Chen" },
    ]);
    const cat = buildEntityIndex(
      roster,
      distinctive("alice", "smith", "jones", "park", "chen"),
    );
    expect(entityLane(cat, roster, "any update from alice chen?", 1)).toEqual([
      { article: "alice-chen", section: 3 },
    ]);
  });
});
