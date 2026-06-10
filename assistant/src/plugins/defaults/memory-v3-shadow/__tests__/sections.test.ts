import { describe, expect, test } from "bun:test";

import { buildSectionIndex, SECTION_CHUNK_CHARS } from "../sections.js";
import type { Slug } from "../types.js";

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
