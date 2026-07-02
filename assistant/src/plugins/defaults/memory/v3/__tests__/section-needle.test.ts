import { describe, expect, test } from "bun:test";

import { buildSectionNeedle } from "../section-needle.js";
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
});
