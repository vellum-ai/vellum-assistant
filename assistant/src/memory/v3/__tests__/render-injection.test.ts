import { describe, expect, test } from "bun:test";

import { renderMemoryBlock } from "../render-injection.js";
import { Slug } from "../types.js";

const resolver =
  (pages: Record<Slug, string>) =>
  async (slug: Slug): Promise<string> =>
    pages[slug] ?? "";

describe("renderMemoryBlock", () => {
  test("wraps the selection in a single <memory> block, in order", async () => {
    const pages: Record<Slug, string> = {
      "page-a": "alpha body",
      "page-b": "beta body",
    };

    const block = await renderMemoryBlock(
      ["page-a", "page-b"],
      resolver(pages),
    );

    expect(block).toBe("<memory>\nalpha body\nbeta body\n</memory>");
  });

  test("empty selection renders the empty string", async () => {
    const block = await renderMemoryBlock([], async () => "unused");
    expect(block).toBe("");
  });

  test("preserves input order deterministically", async () => {
    const pages: Record<Slug, string> = {
      "page-a": "A",
      "page-b": "B",
      "page-c": "C",
    };

    const forward = await renderMemoryBlock(
      ["page-a", "page-b", "page-c"],
      resolver(pages),
    );
    const reversed = await renderMemoryBlock(
      ["page-c", "page-b", "page-a"],
      resolver(pages),
    );

    expect(forward).toBe("<memory>\nA\nB\nC\n</memory>");
    expect(reversed).toBe("<memory>\nC\nB\nA\n</memory>");
  });

  test("reuses the marker the v2 stripper recognizes", async () => {
    const block = await renderMemoryBlock(
      ["page-a"],
      resolver({ "page-a": "x" }),
    );
    expect(block.startsWith("<memory>\n")).toBe(true);
    expect(block.endsWith("\n</memory>")).toBe(true);
  });
});
