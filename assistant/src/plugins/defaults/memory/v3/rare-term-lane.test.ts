import { describe, expect, test } from "bun:test";

import { rareTermLane } from "./rare-term-lane.js";
import { buildSectionNeedle, type SectionNeedle } from "./section-needle.js";
import { buildSectionIndex } from "./sections.js";
import type { SectionIndex, Slug } from "./types.js";

/**
 * A fixture corpus in which "here", "is", "my", and "little" recur
 * across most sections while "gourd" sits in three sections (two on one
 * page), "marrow" in two, and "quince" and "0x1f" in one each. All slugs and
 * content are invented placeholders.
 */
const PAGES: Record<Slug, string> = {
  "silly-lines": [
    "the list of silly lines: here is my little log of bits, here is the joke",
    "## Parody",
    "the parody verse: here is the way it landed, my little friend",
    "## Pumpkin",
    "the pumpkin bit: here is my little gourd, gourd of my heart",
    "## Harvest",
    "harvest song: the gourd on the porch and the gourd in the pie, here is my little ballad",
  ].join("\n"),
  "autumn-recipes": [
    "recipes here and there, my little kitchen notes",
    "## Soup",
    "gourd soup with marrow, here is my little pot, with onions, celery, carrots, thyme, cream, salt, and pepper",
    "## Bread",
    "little loaves, here is my quince jam on top",
  ].join("\n"),
  "daily-notes": [
    "notes here for my little log, is it done",
    "## Monday",
    "here is my monday, my little wins, deploy 0x1f at noon",
    "## Tuesday",
    "marrow on toast, here is my little ritual",
  ].join("\n"),
};

async function corpus(): Promise<{
  index: SectionIndex;
  needle: SectionNeedle;
}> {
  const index = await buildSectionIndex(
    Object.keys(PAGES),
    async (slug) => PAGES[slug]!,
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

const { index, needle } = await corpus();
const pumpkin = docOf(index, "silly-lines", "Pumpkin");
const harvest = docOf(index, "silly-lines", "Harvest");
const soup = docOf(index, "autumn-recipes", "Soup");

const OPTIONS = { maxDf: 3, perTerm: 2, cap: 24 };

describe("rareTermLane", () => {
  test("surfaces a rare word's top sections, tagged with the word, whatever else the message says", () => {
    // "gourd" occurs in three sections; the two that carry it twice in a
    // short body outscore the one that carries it once in a long one.
    expect(
      rareTermLane(needle, index, "here is my little gourd", OPTIONS),
    ).toEqual([
      { article: "silly-lines", section: pumpkin, term: "gourd" },
      { article: "silly-lines", section: harvest, term: "gourd" },
    ]);
  });

  test("perTerm bounds the sections surfaced per word", () => {
    expect(
      rareTermLane(needle, index, "gourd", { ...OPTIONS, perTerm: 1 }),
    ).toEqual([{ article: "silly-lines", section: pumpkin, term: "gourd" }]);
  });

  test("a word above maxDf is ignored", () => {
    expect(
      rareTermLane(needle, index, "gourd", { ...OPTIONS, maxDf: 2 }),
    ).toEqual([]);
    // "little" occurs in every section.
    expect(rareTermLane(needle, index, "little", OPTIONS)).toEqual([]);
  });

  test("a bigram is never eligible", () => {
    // "little gourd" is a phrase of one section only, and the needle indexes
    // the bigram for its query lanes, but the lane keys on unigrams: "little"
    // is common and "gourd" sits above this maxDf.
    expect(needle.topTerms(pumpkin, "little gourd", 3)).toContain(
      "little_gourd",
    );
    expect(
      rareTermLane(needle, index, "little gourd", { ...OPTIONS, maxDf: 2 }),
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
    const message = "gourd quince marrow";
    const hits = rareTermLane(needle, index, message, OPTIONS);
    expect(hits.map((h) => h.term)).toEqual([
      "quince",
      "marrow",
      "marrow",
      "gourd",
      "gourd",
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
    expect(hits.slice(3).map((h) => h.section)).toEqual([pumpkin, harvest]);
    expect(
      rareTermLane(needle, index, message, { ...OPTIONS, cap: 3 }),
    ).toEqual(hits.slice(0, 3));
  });

  test("a section two rare words both score is one hit, under the rarer word", () => {
    // The soup section holds "marrow" (two sections) and "gourd" (three);
    // with perTerm 3 both words reach it.
    const hits = rareTermLane(needle, index, "gourd marrow", {
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
      { ...OPTIONS, perTerm: 0 },
      { ...OPTIONS, cap: 0 },
    ]) {
      expect(rareTermLane(needle, index, "gourd", options)).toEqual([]);
    }
  });
});
