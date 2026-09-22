import { describe, expect, test } from "bun:test";

import { effectiveMaxDf, rareTermLane } from "./rare-term-lane.js";
import { buildSectionNeedle, type SectionNeedle } from "./section-needle.js";
import { buildSectionIndex } from "./sections.js";
import type { SectionIndex, Slug } from "./types.js";

/**
 * A fixture corpus in which "the", "weekly", "report", and "lists" recur in
 * every section while "turnip" sits in three sections (two on one page),
 * "marrow" in two, and "quince" and "0x1f" in one each. All slugs and
 * content are invented placeholders.
 */
const PAGES: Record<Slug, string> = {
  "sample-notes": [
    "the weekly report lists the sample notes and the open items",
    "## Parody",
    "the parody report lists the weekly skit and the encore",
    "## Inventory",
    "the weekly turnip report lists the turnip totals",
    "## Harvest",
    "the weekly harvest report lists the turnip crates and the turnip deliveries",
  ].join("\n"),
  "autumn-recipes": [
    "the weekly recipe report lists the kitchen items",
    "## Soup",
    "turnip soup with marrow: the weekly report lists onions, celery, carrots, thyme, cream, salt, and pepper",
    "## Bread",
    "the weekly bread report lists the quince jam on top",
  ].join("\n"),
  "daily-notes": [
    "the weekly notes report lists the open items",
    "## Monday",
    "the monday report lists the weekly wins and the deploy of 0x1f at noon",
    "## Tuesday",
    "the tuesday report lists marrow on toast as the weekly ritual",
  ].join("\n"),
};

async function corpus(pages: Record<Slug, string>): Promise<{
  index: SectionIndex;
  needle: SectionNeedle;
}> {
  const index = await buildSectionIndex(
    Object.keys(pages),
    async (slug) => pages[slug]!,
  );
  return { index, needle: buildSectionNeedle(index) };
}

/** The section index of `article`'s section titled `title`. */
function docOf(index: SectionIndex, article: Slug, title: string): number {
  const doc = index.byArticle
    .get(article)
    ?.find((d) => index.sections[d]!.title === title);
  if (doc === undefined) {
    throw new Error(`no section ${article} § ${title}`);
  }
  return doc;
}

const { index, needle } = await corpus(PAGES);
const inventory = docOf(index, "sample-notes", "Inventory");
const harvest = docOf(index, "sample-notes", "Harvest");
const soup = docOf(index, "autumn-recipes", "Soup");

// `maxDfFraction: 1` leaves `maxDf` as the sole ceiling on this ten-section
// corpus; the corpus-relative rule has its own fixture below.
const OPTIONS = { maxDf: 3, maxDfFraction: 1, perTerm: 2, cap: 24 };

describe("rareTermLane", () => {
  test("surfaces a rare word's top sections, tagged with the word, whatever else the message says", () => {
    // "turnip" occurs in three sections; the two that carry it twice in a
    // short body outscore the one that carries it once in a long one.
    expect(
      rareTermLane(
        needle,
        index,
        "the weekly report lists the turnip",
        OPTIONS,
      ),
    ).toEqual([
      { article: "sample-notes", section: inventory, term: "turnip" },
      { article: "sample-notes", section: harvest, term: "turnip" },
    ]);
  });

  test("perTerm bounds the sections surfaced per word", () => {
    expect(
      rareTermLane(needle, index, "turnip", { ...OPTIONS, perTerm: 1 }),
    ).toEqual([
      { article: "sample-notes", section: inventory, term: "turnip" },
    ]);
  });

  test("a word above maxDf is ignored", () => {
    expect(
      rareTermLane(needle, index, "turnip", { ...OPTIONS, maxDf: 2 }),
    ).toEqual([]);
    // "weekly" occurs in every section.
    expect(rareTermLane(needle, index, "weekly", OPTIONS)).toEqual([]);
  });

  test("a bigram is never eligible", () => {
    // "weekly turnip" is a phrase of one section only, and the needle indexes
    // the bigram for its query lanes, but the lane keys on unigrams: "weekly"
    // is common and "turnip" sits above this maxDf.
    expect(needle.topTerms(inventory, "weekly turnip", 3)).toContain(
      "weekly_turnip",
    );
    expect(
      rareTermLane(needle, index, "weekly turnip", { ...OPTIONS, maxDf: 2 }),
    ).toEqual([]);
  });

  test("a token the corpus does not hold yields nothing; one it holds matches whatever its shape", () => {
    expect(rareTermLane(needle, index, "ship 9999", OPTIONS)).toEqual([]);
    expect(rareTermLane(needle, index, "ship 0x1f or 9999", OPTIONS)).toEqual([
      {
        article: "daily-notes",
        section: docOf(index, "daily-notes", "Monday"),
        term: "0x1f",
      },
    ]);
  });

  test("hits order rarest word first, then score, and the cap cuts the tail", () => {
    const message = "turnip quince marrow";
    const hits = rareTermLane(needle, index, message, OPTIONS);
    expect(hits.map((h) => h.term)).toEqual([
      "quince",
      "marrow",
      "marrow",
      "turnip",
      "turnip",
    ]);
    expect(hits[0]).toEqual({
      article: "autumn-recipes",
      section: docOf(index, "autumn-recipes", "Bread"),
      term: "quince",
    });
    // Within one word, hits follow the word's own single-term ranking.
    expect(hits.slice(1, 3).map((h) => h.section)).toEqual(
      needle.scoreTerm("marrow", 2).map((h) => h.doc),
    );
    expect(hits.slice(3).map((h) => h.section)).toEqual([inventory, harvest]);
    expect(
      rareTermLane(needle, index, message, { ...OPTIONS, cap: 3 }),
    ).toEqual(hits.slice(0, 3));
  });

  test("a section two rare words both score is one hit, under the rarer word", () => {
    // The soup section holds "marrow" (two sections) and "turnip" (three);
    // with perTerm 3 both words reach it.
    const hits = rareTermLane(needle, index, "turnip marrow", {
      ...OPTIONS,
      perTerm: 3,
    });
    expect(hits).toHaveLength(4);
    expect(hits.filter((h) => h.section === soup)).toEqual([
      { article: "autumn-recipes", section: soup, term: "marrow" },
    ]);
  });

  test("non-positive tuning surfaces nothing", () => {
    for (const options of [
      { ...OPTIONS, maxDf: 0 },
      { ...OPTIONS, maxDfFraction: 0 },
      { ...OPTIONS, perTerm: 0 },
      { ...OPTIONS, cap: 0 },
    ]) {
      expect(rareTermLane(needle, index, "turnip", options)).toEqual([]);
    }
  });
});

/** The distinctive word of the n-th generated section, "" for a filler one. */
function markerOf(n: number): string {
  if (n < 13) {
    return "turnip";
  }
  if (n < 21) {
    return "marrow";
  }
  if (n === 21) {
    return "quince";
  }
  return "";
}

/**
 * A generated corpus of 300 short sections (30 pages of a lead plus nine
 * headings) for the corpus-relative ceiling: "turnip" occurs in 13 sections,
 * "marrow" in 8, "quince" in 1, and the filler in every one.
 */
const WIDE_PAGES: Record<Slug, string> = Object.fromEntries(
  Array.from({ length: 30 }, (_, page): [Slug, string] => {
    const lines: string[] = [];
    for (let heading = 0; heading < 10; heading++) {
      if (heading > 0) {
        lines.push(`## Part ${heading}`);
      }
      lines.push(
        `the weekly report lists ${markerOf(page * 10 + heading)}`.trimEnd(),
      );
    }
    return [`wide-${String(page).padStart(2, "0")}`, lines.join("\n")];
  }),
);

const wide = await corpus(WIDE_PAGES);

describe("rareTermLane corpus-relative ceiling", () => {
  const TUNED = { maxDf: 12, perTerm: 2, cap: 24 };
  const MESSAGE = "turnip quince marrow";

  test("the fixture holds 300 sections with words of df 13, 8, and 1", () => {
    expect(wide.index.sections).toHaveLength(300);
    expect(wide.needle.df("turnip")).toBe(13);
    expect(wide.needle.df("marrow")).toBe(8);
    expect(wide.needle.df("quince")).toBe(1);
  });

  test("on a few hundred sections the default fraction admits only a word unique to one section", () => {
    // floor(300 * 0.002) = 0, floored to 1: "marrow" (df 8) sits under
    // `maxDf` but not under the corpus-relative ceiling.
    const options = { ...TUNED, maxDfFraction: 0.002 };
    expect(effectiveMaxDf(wide.index.sections.length, options)).toBe(1);
    expect(
      rareTermLane(wide.needle, wide.index, MESSAGE, options).map(
        (h) => h.term,
      ),
    ).toEqual(["quince"]);
  });

  test("a fraction whose corpus share exceeds maxDf leaves maxDf binding", () => {
    // floor(300 * 0.05) = 15, above `maxDf`: "marrow" (df 8) is rare again
    // and "turnip" (df 13) still is not.
    const options = { ...TUNED, maxDfFraction: 0.05 };
    expect(effectiveMaxDf(wide.index.sections.length, options)).toBe(12);
    expect(
      rareTermLane(wide.needle, wide.index, MESSAGE, options).map(
        (h) => h.term,
      ),
    ).toEqual(["quince", "marrow", "marrow"]);
  });
});

describe("effectiveMaxDf", () => {
  const DEFAULTS = { maxDf: 12, maxDfFraction: 0.002 };

  test("a large corpus keeps maxDf as the binding ceiling", () => {
    // The corpus the defaults were tuned on: floor(27.33) = 27, above 12.
    expect(effectiveMaxDf(13_665, DEFAULTS)).toBe(12);
    expect(effectiveMaxDf(6_000, DEFAULTS)).toBe(12);
  });

  test("below that the ceiling scales with the corpus, never under 1", () => {
    expect(effectiveMaxDf(5_999, DEFAULTS)).toBe(11);
    expect(effectiveMaxDf(5_000, DEFAULTS)).toBe(10);
    expect(effectiveMaxDf(1_000, DEFAULTS)).toBe(2);
    expect(effectiveMaxDf(150, DEFAULTS)).toBe(1);
    expect(effectiveMaxDf(0, DEFAULTS)).toBe(1);
  });

  test("a fraction of 1 leaves maxDf as the sole ceiling", () => {
    expect(effectiveMaxDf(10, { maxDf: 3, maxDfFraction: 1 })).toBe(3);
  });
});
