import { describe, expect, test } from "bun:test";

import { wrapMemoryBlock } from "../../../../memory/memory-marker.js";
import {
  renderCardsBlockInner,
  renderMemoryBlock,
  renderSpotlightInner,
  V3_CARDS_INJECTION_HEADER,
} from "../render-injection.js";
import type { Section, Slug } from "../types.js";

function section(article: Slug, text: string): Section {
  return { article, title: "", text, ordinal: 0 };
}

/**
 * Stub resolver mirroring `renderV3SectionContent`'s branch: render the matched
 * section's text when present, otherwise fall back to a "full body" stand-in.
 */
const resolver =
  (fullBodies: Record<Slug, string>) =>
  async (slug: Slug, sec: Section | undefined): Promise<string> =>
    sec ? sec.text : (fullBodies[slug] ?? "");

describe("renderCardsBlockInner", () => {
  test("prefixes the v2 read-affordance header and joins cards with blank lines", () => {
    const inner = renderCardsBlockInner([
      "# memory/concepts/page-a.md\nhead a",
      "# memory/concepts/page-b.md\nhead b",
    ]);
    expect(inner).toBe(
      `${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nhead a\n\n# memory/concepts/page-b.md\nhead b`,
    );
  });

  test("empty card list renders the empty string (no header-only block)", () => {
    expect(renderCardsBlockInner([])).toBe("");
  });
});

describe("renderSpotlightInner", () => {
  test("renders each entry as a § header plus section text", () => {
    const inner = renderSpotlightInner([
      { slug: "page-a", title: "Alpha", text: "alpha text" },
      { slug: "page-b", title: "Beta", text: "beta text" },
    ]);
    expect(inner).toBe(
      "## memory/concepts/page-a.md § Alpha\nalpha text\n\n## memory/concepts/page-b.md § Beta\nbeta text",
    );
  });

  test("empty window renders the empty string", () => {
    expect(renderSpotlightInner([])).toBe("");
  });
});

describe("renderMemoryBlock", () => {
  test("renders the matched section (not the full body) for each slug", async () => {
    const sections = new Map<Slug, Section>([
      ["page-a", section("page-a", "matched section A")],
      ["topic-x", section("topic-x", "matched section X")],
    ]);

    const block = await renderMemoryBlock(
      ["page-a", "topic-x"],
      sections,
      resolver({ "page-a": "FULL body A", "topic-x": "FULL body X" }),
    );

    expect(block).toBe(
      "<memory>\nmatched section A\nmatched section X\n</memory>",
    );
    expect(block).not.toContain("FULL body");
  });

  test("falls back to the full/lead body for a slug with no matched section", async () => {
    const sections = new Map<Slug, Section>([
      ["page-a", section("page-a", "matched section A")],
    ]);

    const block = await renderMemoryBlock(
      ["page-a", "topic-x"],
      sections,
      resolver({ "topic-x": "lead body X" }),
    );

    // page-a renders its matched section; topic-x (no entry) falls back.
    expect(block).toBe("<memory>\nmatched section A\nlead body X\n</memory>");
  });

  test("empty selection renders the empty string", async () => {
    const block = await renderMemoryBlock([], new Map(), async () => "unused");
    expect(block).toBe("");
  });

  test("preserves input order deterministically", async () => {
    const sections = new Map<Slug, Section>([
      ["page-a", section("page-a", "A")],
      ["page-b", section("page-b", "B")],
      ["page-c", section("page-c", "C")],
    ]);

    const forward = await renderMemoryBlock(
      ["page-a", "page-b", "page-c"],
      sections,
      resolver({}),
    );
    const reversed = await renderMemoryBlock(
      ["page-c", "page-b", "page-a"],
      sections,
      resolver({}),
    );

    expect(forward).toBe("<memory>\nA\nB\nC\n</memory>");
    expect(reversed).toBe("<memory>\nC\nB\nA\n</memory>");
  });

  test("emits the shared wrapMemoryBlock marker the v2 stripper recognizes", async () => {
    const block = await renderMemoryBlock(
      ["page-a"],
      new Map([["page-a", section("page-a", "x")]]),
      resolver({}),
    );
    // Guard the v2/v3 marker contract: the rendered block must be byte-identical
    // to wrapping the joined content with the shared helper.
    expect(block).toBe(wrapMemoryBlock("x"));
  });
});
