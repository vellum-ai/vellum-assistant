import { describe, expect, test } from "bun:test";

import { listOverlongSections } from "../overlong-sections.js";
import { SECTION_CHUNK_CHARS, sectionHeadLine } from "../sections.js";
import type { Slug } from "../types.js";

/** The longest body a section can carry before the chunker splits it. */
function bodyLimit(article: Slug, title: string): number {
  return SECTION_CHUNK_CHARS - sectionHeadLine(article, title).length - 1;
}

/** The indexed size of a section: its head line, a newline, and its body. */
function indexedChars(article: Slug, title: string, body: string): number {
  return sectionHeadLine(article, title).length + 1 + body.length;
}

/** Deps over a fixture map, scanned in the map's key order. */
function deps(pages: Record<string, string>) {
  return {
    listSlugs: async () => Object.keys(pages) as Slug[],
    readPageBody: async (slug: Slug) => pages[slug] ?? "",
  };
}

describe("listOverlongSections", () => {
  test("reports exactly the sections the chunker splits, with the window and each body's length", async () => {
    const fits = "x".repeat(bodyLimit("notes", "Fits"));
    const over = "y".repeat(bodyLimit("notes", "Over") + 1);
    const leadOver = "z".repeat(bodyLimit("journal", "") + 1);

    const report = await listOverlongSections(
      "/unused",
      deps({
        notes: `lead\n## Fits\n${fits}\n## Over\n${over}\n## Short\nshort`,
        journal: `${leadOver}\n## Small\ntext`,
      }),
    );

    expect(report.windowChars).toBe(SECTION_CHUNK_CHARS);
    expect(report.sections).toEqual([
      {
        slug: "notes",
        title: "Over",
        chars: indexedChars("notes", "Over", over),
      },
      {
        slug: "journal",
        title: "",
        chars: indexedChars("journal", "", leadOver),
      },
    ]);
    // The reported size is what the window applies to, so it always reads
    // as over the window even when the body alone does not.
    expect(over.length).toBeLessThan(SECTION_CHUNK_CHARS);
    expect(report.sections[0]!.chars).toBeGreaterThan(SECTION_CHUNK_CHARS);
  });

  test("a repeated heading carries its occurrence, the first included, so the right one is named", async () => {
    const over = "y".repeat(bodyLimit("notes", "Notes") + 1);
    const chars = indexedChars("notes", "Notes", over);

    const report = await listOverlongSections(
      "/unused",
      deps({
        notes: `## Notes\n${over}\n## Notes\nshort\n## Notes\n${over}\n## Alone\n${over}`,
      }),
    );

    expect(report.sections).toEqual([
      { slug: "notes", title: "Notes", chars, occurrence: 0 },
      { slug: "notes", title: "Notes", chars, occurrence: 2 },
      {
        slug: "notes",
        title: "Alone",
        chars: indexedChars("notes", "Alone", over),
      },
    ]);
  });

  test("a blank heading shares the lead's empty title and is told apart by occurrence", async () => {
    const over = "y".repeat(bodyLimit("notes", "") + 1);

    const report = await listOverlongSections(
      "/unused",
      deps({ notes: `lead text\n## \n${over}` }),
    );

    expect(report.sections).toEqual([
      {
        slug: "notes",
        title: "",
        chars: indexedChars("notes", "", over),
        occurrence: 1,
      },
    ]);
  });

  test("a corpus with nothing over the window reports no sections", async () => {
    const report = await listOverlongSections(
      "/unused",
      deps({
        notes: "lead\n## One\nshort\n## Two\nalso short",
        empty: "",
      }),
    );

    expect(report.sections).toEqual([]);
  });
});
