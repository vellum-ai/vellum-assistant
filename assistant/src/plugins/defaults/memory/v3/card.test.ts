import { describe, expect, test } from "bun:test";

import { cardBytes, renderCard } from "./card.js";

describe("renderCard", () => {
  test("standard article renders head section + section TOC", () => {
    const raw = [
      "---",
      "summary: A page about topic A.",
      "---",
      "# Topic A",
      "",
      "Lead paragraph one about topic A.",
      "",
      "Lead paragraph two with more detail.",
      "",
      "## History",
      "history body",
      "",
      "## Design",
      "design body",
      "",
      "## Open Questions",
      "open questions body",
    ].join("\n");

    expect(renderCard("page-a", raw)).toBe(
      [
        "# memory/concepts/page-a.md",
        "# Topic A",
        "",
        "Lead paragraph one about topic A.",
        "",
        "Lead paragraph two with more detail.",
        "",
        "[sections: §History · §Design · §Open Questions]",
      ].join("\n"),
    );
  });

  test("kind: index page renders its links: map instead of section names", () => {
    const longNote = "x".repeat(100);
    const raw = [
      "---",
      "kind: index",
      "links:",
      "  - page-a — short note about page a",
      `  - page-b — ${longNote}`,
      "  - page-c",
      "---",
      "# Index of Topics",
      "",
      "Lead line.",
      "",
      "## Pages",
      "generic section body",
    ].join("\n");

    const card = renderCard("topics-index", raw);
    expect(card).toBe(
      [
        "# memory/concepts/topics-index.md",
        "# Index of Topics",
        "",
        "Lead line.",
        "",
        `[linked: page-a — short note about page a · page-b — ${"x".repeat(80)}… · page-c]`,
      ].join("\n"),
    );
    // Section names never appear on an index card.
    expect(card).not.toContain("§Pages");
  });

  test("kind: index without usable links falls back to section names", () => {
    const raw = [
      "---",
      "kind: index",
      "---",
      "# Bare Index",
      "",
      "## Pages",
      "body",
    ].join("\n");

    expect(renderCard("bare-index", raw)).toBe(
      [
        "# memory/concepts/bare-index.md",
        "# Bare Index",
        "",
        "[sections: §Pages]",
      ].join("\n"),
    );
  });

  test("sectionless page omits the TOC line", () => {
    const raw = [
      "---",
      "summary: s",
      "---",
      "# Sectionless",
      "",
      "Just a lead.",
    ].join("\n");

    expect(renderCard("page-b", raw)).toBe(
      ["# memory/concepts/page-b.md", "# Sectionless", "", "Just a lead."].join(
        "\n",
      ),
    );
  });

  test("frontmatter-less text renders head + TOC", () => {
    const raw = [
      "# No Frontmatter",
      "",
      "Lead.",
      "",
      "## Only Section",
      "body",
    ].join("\n");

    expect(renderCard("page-c", raw)).toBe(
      [
        "# memory/concepts/page-c.md",
        "# No Frontmatter",
        "",
        "Lead.",
        "",
        "[sections: §Only Section]",
      ].join("\n"),
    );
  });

  test("body starting at a ## heading renders header + TOC with no head block", () => {
    const raw = ["## First", "body", "", "## Second", "body"].join("\n");

    expect(renderCard("page-d", raw)).toBe(
      ["# memory/concepts/page-d.md", "", "[sections: §First · §Second]"].join(
        "\n",
      ),
    );
  });

  test("long lead injects whole (no length cap)", () => {
    const longLead = `Long lead. ${"y".repeat(10_000)}`;
    const raw = ["# Long", "", longLead, "", "## Section", "body"].join("\n");

    expect(renderCard("page-e", raw)).toContain(longLead);
  });

  test("deterministic for the same input", () => {
    const raw = ["# T", "", "Lead.", "", "## S", "b"].join("\n");
    expect(renderCard("page-f", raw)).toBe(renderCard("page-f", raw));
  });
});

describe("cardBytes", () => {
  test("counts UTF-8 bytes, not characters", () => {
    expect(cardBytes("abc")).toBe(3);
    expect(cardBytes("§")).toBe(2); // U+00A7 is 2 bytes in UTF-8
  });

  test("accounts for a rendered card's full byte footprint", () => {
    const card = renderCard(
      "page-a",
      ["# T", "", "Lead.", "", "## S", "b"].join("\n"),
    );
    // The card contains exactly one multibyte char (the TOC's "§"), so its
    // byte footprint is one over its character length.
    expect(card.match(/§/g)).toHaveLength(1);
    expect(cardBytes(card)).toBe(card.length + 1);
  });
});
