import { describe, expect, test } from "bun:test";

import {
  buildSectionIndex,
  leadSectionOfBody,
  SECTION_CHUNK_CHARS,
  sectionBody,
  sectionHeadLine,
} from "../sections.js";
import { sectionKey, type Slug } from "../types.js";

/** Build a page-body reader from a fixture map. */
function reader(pages: Record<string, string>) {
  return async (slug: Slug): Promise<string> => pages[slug] ?? "";
}

describe("buildSectionIndex", () => {
  test("lead + two ## sections yield 3 ordered sections with titles", async () => {
    const body = [
      "Lead paragraph before any heading.",
      "",
      "## First Heading",
      "first body line",
      "",
      "## Second Heading",
      "second body line",
    ].join("\n");

    const index = await buildSectionIndex(
      ["page-a"],
      reader({ "page-a": body }),
    );

    expect(index.sections).toHaveLength(3);

    expect(index.sections[0]!.ordinal).toBe(0);
    expect(index.sections[0]!.title).toBe("");
    expect(index.sections[0]!.text).toContain("page-a — ");
    expect(index.sections[0]!.text).toContain("Lead paragraph");

    expect(index.sections[1]!.ordinal).toBe(1);
    expect(index.sections[1]!.title).toBe("First Heading");
    expect(index.sections[1]!.text).toContain("page-a — First Heading");
    expect(index.sections[1]!.text).toContain("first body line");

    expect(index.sections[2]!.ordinal).toBe(2);
    expect(index.sections[2]!.title).toBe("Second Heading");
    expect(index.sections[2]!.text).toContain("second body line");
  });

  test("section over the chunk cap splits into ordered chunks", async () => {
    const big = "x".repeat(SECTION_CHUNK_CHARS * 2 + 100);
    const body = `## Big Section\n${big}`;

    const index = await buildSectionIndex(
      ["topic-x"],
      reader({ "topic-x": body }),
    );

    // Lead (empty) + the chunked big section.
    const bigChunks = index.sections.filter((s) => s.title === "Big Section");
    expect(bigChunks.length).toBeGreaterThan(1);

    // Every chunk fits the embedding window.
    for (const section of index.sections) {
      expect(section.text.length).toBeLessThanOrEqual(SECTION_CHUNK_CHARS);
    }

    // Ordinals are strictly increasing in array order (chunks ordered).
    for (let i = 1; i < index.sections.length; i++) {
      expect(index.sections[i]!.ordinal).toBe(
        index.sections[i - 1]!.ordinal + 1,
      );
    }
  });

  test("byArticle maps each article to its section indices", async () => {
    const index = await buildSectionIndex(
      ["page-a", "topic-x"],
      reader({
        "page-a": "lead a\n\n## Sec A\nbody a",
        "topic-x": "lead x",
      }),
    );

    expect([...index.byArticle.keys()].sort()).toEqual(["page-a", "topic-x"]);

    for (const [article, indices] of index.byArticle) {
      for (const i of indices) {
        expect(index.sections[i]!.article).toBe(article);
      }
    }

    // page-a has lead + one heading section; topic-x is headingless (lead only).
    expect(index.byArticle.get("page-a")).toHaveLength(2);
    expect(index.byArticle.get("topic-x")).toHaveLength(1);
  });

  test("empty / headingless page yields a single ordinal-0 section", async () => {
    const empty = await buildSectionIndex(["page-a"], reader({ "page-a": "" }));
    expect(empty.sections).toHaveLength(1);
    expect(empty.sections[0]!.ordinal).toBe(0);
    expect(empty.sections[0]!.title).toBe("");

    const headingless = await buildSectionIndex(
      ["topic-x"],
      reader({ "topic-x": "just a paragraph\nand another line" }),
    );
    expect(headingless.sections).toHaveLength(1);
    expect(headingless.sections[0]!.ordinal).toBe(0);
    expect(headingless.sections[0]!.text).toContain("just a paragraph");
  });

  test("sections are deterministic, sorted by (article, ordinal)", async () => {
    const pages = {
      "topic-x": "lead x\n\n## X1\nbody",
      "page-a": "lead a\n\n## A1\nbody",
    };
    const first = await buildSectionIndex(["topic-x", "page-a"], reader(pages));
    const second = await buildSectionIndex(
      ["page-a", "topic-x"],
      reader(pages),
    );

    const shape = (s: { article: Slug; ordinal: number }) =>
      `${s.article}#${s.ordinal}`;
    expect(first.sections.map(shape)).toEqual(second.sections.map(shape));
    // page-a sorts before topic-x regardless of input order.
    expect(first.sections[0]!.article).toBe("page-a");
  });
});

describe("section keys", () => {
  test('the lead keys as "", a heading as its title, and repeated headings count up', async () => {
    const body = [
      "# Title",
      "lead",
      "",
      "## Notes",
      "first notes",
      "",
      "## Design",
      "design",
      "",
      "## Notes",
      "second notes block under the same heading",
    ].join("\n");
    const index = await buildSectionIndex(
      ["page-a"],
      reader({ "page-a": body }),
    );

    expect(index.sections.map(sectionKey)).toEqual([
      "",
      "Notes",
      "Design",
      "Notes#1",
    ]);
    expect(index.sections[3]!.titleOrdinal).toBe(1);
    expect(index.sections[1]!.titleOrdinal).toBeUndefined();
  });

  test("a literal `## Topic#1` heading and a repeated `## Topic` get distinct keys", async () => {
    const body = [
      "lead",
      "",
      "## Topic#1",
      "literal numbered heading",
      "",
      "## Topic",
      "first plain",
      "",
      "## Topic",
      "second plain",
    ].join("\n");
    const index = await buildSectionIndex(
      ["page-a"],
      reader({ "page-a": body }),
    );

    const keys = index.sections.map(sectionKey);
    expect(keys).toEqual(["", "Topic##1", "Topic", "Topic#1"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a split heading's later chunks key as title#<n> and stay stable when earlier sections move", async () => {
    const longBody = "x".repeat(SECTION_CHUNK_CHARS * 2 + 50);
    const page = (prefixSections: number) =>
      [
        "lead",
        ...Array.from(
          { length: prefixSections },
          (_, i) => `\n## Extra ${i}\nbody`,
        ),
        "\n## Long",
        longBody,
      ].join("\n");

    const before = await buildSectionIndex(["p"], reader({ p: page(0) }));
    const after = await buildSectionIndex(["p"], reader({ p: page(2) }));
    const longKeys = (index: typeof before) =>
      index.sections.filter((s) => s.title === "Long").map(sectionKey);

    const chunks = longKeys(before).length;
    expect(chunks).toBeGreaterThan(2);
    expect(longKeys(before)).toEqual(
      Array.from({ length: chunks }, (_, i) =>
        i === 0 ? "Long" : `Long#${i}`,
      ),
    );
    // Two sections inserted above shift every ordinal but leave the keys.
    expect(longKeys(after)).toEqual(longKeys(before));
    expect(after.sections.find((s) => s.title === "Long")!.ordinal).not.toBe(
      before.sections.find((s) => s.title === "Long")!.ordinal,
    );
  });

  test("leadSectionOfBody is exactly the index's lead for that page", async () => {
    const pages = {
      "topics/page-a": "# Page A\nlead text\n\n## Notes\nnote body",
      "page-empty": "",
      "page-long": "x".repeat(SECTION_CHUNK_CHARS * 2),
    };
    const index = await buildSectionIndex(Object.keys(pages), reader(pages));
    for (const [slug, body] of Object.entries(pages)) {
      const indexed = index.sections[index.byArticle.get(slug)![0]!]!;
      expect(leadSectionOfBody(slug, body)).toEqual(indexed);
    }
  });

  test("sectionBody strips the synthetic head line only when present", async () => {
    const index = await buildSectionIndex(
      ["topics/page-a"],
      reader({ "topics/page-a": "# Page A\nlead text\n\n## Notes\nnote body" }),
    );
    const [lead, notes] = index.sections;
    expect(lead!.text.startsWith(sectionHeadLine("topics/page-a", ""))).toBe(
      true,
    );
    expect(sectionBody(lead!)).toBe("# Page A\nlead text\n");
    expect(sectionBody(notes!)).toBe("note body");
    // A section carrying no head line (a later chunk, or a hand-built
    // section) is returned as-is.
    expect(
      sectionBody({
        article: "topics/page-a",
        title: "Notes",
        text: "raw",
        ordinal: 9,
      }),
    ).toBe("raw");
    expect(
      sectionBody({
        article: "topics/page-a",
        title: "Notes",
        text: sectionHeadLine("topics/page-a", "Notes"),
        ordinal: 1,
      }),
    ).toBe("");
  });
});
