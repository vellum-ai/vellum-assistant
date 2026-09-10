import { describe, expect, test } from "bun:test";

import { buildSectionNeedle, findTerm } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import type { SectionIndex, Slug } from "../types.js";

/**
 * Build a `SectionIndex` from a fixture page-body map. All slugs and content
 * are invented placeholders — no real content.
 */
async function index(pages: Record<string, string>): Promise<SectionIndex> {
  const reader = async (slug: Slug): Promise<string> => pages[slug] ?? "";
  return buildSectionIndex(Object.keys(pages), reader);
}

describe("buildSectionNeedle", () => {
  test("a term present only in one section ranks that section's article", async () => {
    const idx = await index({
      "page-a": [
        "## Intro",
        "general background prose",
        "",
        "## Details",
        "the elephant appears only here",
      ].join("\n"),
      "topic-x": "## Notes\nunrelated material about gardens",
    });

    const needle = buildSectionNeedle(idx);
    const results = needle.query("elephant", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.article).toBe("page-a");
    // The matched section is the "Details" section, not the lead/intro.
    expect(idx.sections[results[0]!.section]!.title).toBe("Details");
  });

  test("dedupe keeps one entry per article with its top section", async () => {
    const idx = await index({
      "page-a": [
        "## First",
        "zebra zebra zebra mention",
        "",
        "## Second",
        "single zebra mention",
      ].join("\n"),
    });

    const needle = buildSectionNeedle(idx);
    const results = needle.query("zebra", 5);

    // Only one entry for page-a despite two matching sections.
    expect(results).toHaveLength(1);
    expect(results[0]!.article).toBe("page-a");
    // The denser "First" section wins.
    expect(idx.sections[results[0]!.section]!.title).toBe("First");
  });

  test("bestSection returns the highest-scoring section for an article", async () => {
    const idx = await index({
      "page-a": [
        "## Alpha",
        "background filler text",
        "",
        "## Beta",
        "the keyword giraffe lives here",
      ].join("\n"),
    });

    const needle = buildSectionNeedle(idx);
    const best = needle.bestSection("page-a", "giraffe");

    expect(idx.sections[best]!.title).toBe("Beta");
  });

  test("bestSection falls back to first section when no term matches", async () => {
    const idx = await index({
      "page-a": "## Alpha\nfiller\n\n## Beta\nmore filler",
    });

    const needle = buildSectionNeedle(idx);
    const best = needle.bestSection("page-a", "nonexistentterm");

    // First section index for the article (the lead, ordinal 0).
    expect(best).toBe(idx.byArticle.get("page-a")![0]!);
    expect(idx.sections[best]!.ordinal).toBe(0);
  });

  test("bestSection returns -1 for an unknown article", async () => {
    const idx = await index({ "page-a": "## Alpha\nfiller" });
    const needle = buildSectionNeedle(idx);
    expect(needle.bestSection("missing-page", "anything")).toBe(-1);
  });

  test("k truncation is respected", async () => {
    const idx = await index({
      "page-a": "## S\nshared keyword apple here",
      "page-b": "## S\nshared keyword apple here too",
      "page-c": "## S\nshared keyword apple again",
    });

    const needle = buildSectionNeedle(idx);
    expect(needle.query("apple", 2)).toHaveLength(2);
    expect(needle.query("apple", 0)).toHaveLength(0);
  });

  test("head-field term outranks the same term in body", async () => {
    // Same term in the head line (title) of page-a vs in the body of topic-x.
    // Bodies are padded to comparable length so the only edge is field weight.
    const idx = await index({
      "page-a": "## Mango\nfiller words to balance length across the docs here",
      "topic-x":
        "## Notes\nfiller words mango plus more padding to balance length",
    });

    const needle = buildSectionNeedle(idx);
    const results = needle.query("mango", 5);

    expect(results[0]!.article).toBe("page-a");
  });

  test("deterministic tie-breaking by (article, ordinal)", async () => {
    // Identical content across two articles → identical scores; the lexically
    // smaller article wins the tie.
    const idx = await index({
      "page-b": "## S\nidentical pineapple content",
      "page-a": "## S\nidentical pineapple content",
    });

    const needle = buildSectionNeedle(idx);
    const results = needle.query("pineapple", 5);

    expect(results.map((r) => r.article)).toEqual(["page-a", "page-b"]);
  });
});

describe("queryScored", () => {
  /** Drop the score, leaving the shape `query` returns. */
  const strip = ({ article, section }: { article: Slug; section: number }) => ({
    article,
    section,
  });

  test("scores are non-increasing in rank order", async () => {
    const idx = await index({
      "page-a": "## S\nshared keyword apple here",
      "page-b": "## S\nshared keyword apple here too with extra apple apple",
      "page-c": "## S\nshared keyword apple again",
    });

    const needle = buildSectionNeedle(idx);
    const hits = needle.queryScored("apple", 5);

    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });

  test("parity with query (scores stripped)", async () => {
    const idx = await index({
      "page-a": "## S\nshared keyword apple here",
      "page-b": "## S\nshared keyword apple here too",
      "page-c": "## S\nshared keyword apple again",
    });

    const needle = buildSectionNeedle(idx);
    for (const k of [1, 2, 5]) {
      expect(needle.queryScored("apple", k).map(strip)).toEqual(
        needle.query("apple", k),
      );
    }
  });

  test("top score is positive and discriminates between hits", async () => {
    const idx = await index({
      "page-a":
        "## Intro\ngeneral background prose\n\n## Details\nthe elephant appears only here",
      "topic-x": "## Notes\nunrelated material about gardens",
    });

    const needle = buildSectionNeedle(idx);
    const hits = needle.queryScored("elephant", 5);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.score).toBeGreaterThan(0);
    if (hits.length >= 2) {
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    }
  });

  test("empty for no match and for k <= 0", async () => {
    const idx = await index({ "page-a": "## S\nshared keyword apple here" });
    const needle = buildSectionNeedle(idx);

    expect(needle.queryScored("zzzznomatch", 5)).toEqual([]);
    expect(needle.queryScored("apple", 0)).toEqual([]);
  });

  test("topTerms ranks a section's query terms by their BM25F contribution, capped at n", async () => {
    const idx = await index({
      "page-a": [
        "## Mango",
        "the mango tree and the common word appear here",
      ].join("\n"),
      "page-b": "## Notes\ncommon filler about gardens and the",
    });
    const needle = buildSectionNeedle(idx);
    const [, mangoDoc] = idx.byArticle.get("page-a")!;

    // "mango" sits in the head line and the body, "tree" only in the body,
    // "common" in the body of two sections (lower IDF), "missing" nowhere.
    expect(needle.topTerms(mangoDoc!, "mango common tree missing", 3)).toEqual([
      "mango",
      "tree",
      "common",
    ]);
    expect(needle.topTerms(mangoDoc!, "mango common tree missing", 2)).toEqual([
      "mango",
      "tree",
    ]);
    expect(needle.topTerms(mangoDoc!, "missing absent", 3)).toEqual([]);
    expect(needle.topTerms(mangoDoc!, "mango", 0)).toEqual([]);
    expect(needle.topTerms(-1, "mango", 3)).toEqual([]);
    expect(needle.topTerms(idx.sections.length, "mango", 3)).toEqual([]);
  });

  test("topTerms includes adjacent-token bigrams and breaks score ties by term", async () => {
    const idx = await index({
      "page-a": "## Mango\nthe mango tree grows here",
    });
    const needle = buildSectionNeedle(idx);
    const [, mangoDoc] = idx.byArticle.get("page-a")!;

    // "mango_tree" occurs once in the body like "tree" does, so the two tie
    // and sort by term; "mango" outranks both from its head-line weight.
    expect(needle.topTerms(mangoDoc!, "mango tree", 3)).toEqual([
      "mango",
      "mango_tree",
      "tree",
    ]);
  });

  test("findTerm locates a term as a whole token, case-insensitively, and a bigram across punctuation", () => {
    expect(findTerm("The Turnip sits here", "turnip")).toEqual({
      start: 4,
      end: 10,
    });
    // A substring inside a longer token is not an occurrence.
    expect(findTerm("turnips and turnip", "turnip")).toEqual({
      start: 12,
      end: 18,
    });
    expect(findTerm("we said: weekly, turnip", "weekly_turnip")).toEqual({
      start: 9,
      end: 23,
    });
    expect(findTerm("nothing here", "turnip")).toBeUndefined();
    // Only tokenizer-shaped terms are searched.
    expect(findTerm("a (b) c", "(b)")).toBeUndefined();
  });
});

describe("df and scoreTerm", () => {
  test("df counts the sections a unigram occurs in, head or body, and reads 0 when absent", async () => {
    const idx = await index({
      "page-a": "## Mango\nthe mango tree\n\n## Notes\nno fruit here",
      "page-b": "## Notes\nmango jam",
    });
    const needle = buildSectionNeedle(idx);

    expect(needle.df("mango")).toBe(2);
    // Head-line occurrences count: both `## Notes` headings.
    expect(needle.df("notes")).toBe(2);
    expect(needle.df("fruit")).toBe(1);
    expect(needle.df("absent")).toBe(0);
  });

  test("a bigram is never a single-term signal: df 0 and no hits", async () => {
    const idx = await index({
      "page-a": "## Notes\nthe mango tree grows here",
    });
    const needle = buildSectionNeedle(idx);
    const [, notesDoc] = idx.byArticle.get("page-a")!;

    // The bigram is indexed for the query lanes but reads as absent here.
    expect(needle.topTerms(notesDoc!, "mango tree", 3)).toContain("mango_tree");
    expect(needle.df("mango_tree")).toBe(0);
    expect(needle.scoreTerm("mango_tree", 3)).toEqual([]);
  });

  test("scoreTerm ranks a unigram's sections by its own contribution, head above body, cut at k", async () => {
    const idx = await index({
      "page-a": "## Mango\nfiller words to balance length across the docs here",
      "page-b":
        "## Notes\nfiller words mango plus more padding to balance length",
      "page-c": "## Notes\nnothing relevant",
    });
    const needle = buildSectionNeedle(idx);
    const [, mangoDoc] = idx.byArticle.get("page-a")!;
    const [, notesDoc] = idx.byArticle.get("page-b")!;

    const hits = needle.scoreTerm("mango", 5);
    expect(hits.map((h) => h.doc)).toEqual([mangoDoc, notesDoc]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(needle.scoreTerm("mango", 1).map((h) => h.doc)).toEqual([mangoDoc]);
    expect(needle.scoreTerm("mango", 0)).toEqual([]);
    expect(needle.scoreTerm("absent", 5)).toEqual([]);
  });

  test("scoreTerm breaks score ties by (article, ordinal)", async () => {
    const idx = await index({
      "page-b": "## S\nidentical pineapple content",
      "page-a": "## S\nidentical pineapple content",
    });
    const needle = buildSectionNeedle(idx);

    expect(
      needle.scoreTerm("pineapple", 5).map((h) => idx.sections[h.doc]!.article),
    ).toEqual(["page-a", "page-b"]);
  });
});
