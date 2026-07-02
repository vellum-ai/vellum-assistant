import { describe, expect, test } from "bun:test";

import type { ImageBlock, TableBlock } from "@slack/types";

import { renderSlackBlocks } from "./render.js";

describe("renderSlackBlocks", () => {
  test("returns undefined for empty input", () => {
    expect(renderSlackBlocks("")).toBeUndefined();
    expect(renderSlackBlocks("   ")).toBeUndefined();
  });

  test("renders prose as a markdown block carrying the exact GFM", () => {
    const blocks = renderSlackBlocks(
      "See [docs](https://example.com) and **bold**.",
    );
    expect(blocks).toEqual([
      {
        type: "markdown",
        text: "See [docs](https://example.com) and **bold**.",
      },
    ]);
  });

  test("coalesces consecutive paragraphs into one markdown block", () => {
    const blocks = renderSlackBlocks("Para one.\n\nPara two.");
    expect(blocks).toEqual([
      { type: "markdown", text: "Para one.\n\nPara two." },
    ]);
  });

  test("renders a heading as a header block, body as markdown", () => {
    const blocks = renderSlackBlocks("# Title\n\nBody text.");
    expect(blocks![0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Title", emoji: true },
    });
    expect(blocks![1]).toEqual({ type: "markdown", text: "Body text." });
  });

  test("keeps fenced code in a markdown block", () => {
    const blocks = renderSlackBlocks("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([
      { type: "markdown", text: "```ts\nconst x = 1;\n```" },
    ]);
  });

  test("renders a `---` rule as a divider between markdown blocks", () => {
    const blocks = renderSlackBlocks("before\n\n---\n\nafter");
    expect(blocks!.map((b) => b.type)).toEqual([
      "markdown",
      "divider",
      "markdown",
    ]);
  });

  test("renders a GFM table as a Slack table block", () => {
    const table = ["| Tool | Price |", "| --- | --- |", "| Alpha | $10 |"].join(
      "\n",
    );
    const blocks = renderSlackBlocks(table);
    expect(blocks!.length).toBe(1);
    expect(blocks![0]).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Tool" },
          { type: "raw_text", text: "Price" },
        ],
        [
          { type: "raw_text", text: "Alpha" },
          { type: "raw_text", text: "$10" },
        ],
      ],
    });
  });

  test("preserves inline formatting inside table cells via rich_text", () => {
    const table = [
      "| Name | Link |",
      "| --- | --- |",
      "| **bob** | [site](https://e.com) |",
    ].join("\n");
    const blocks = renderSlackBlocks(table);
    const t = blocks![0] as TableBlock;
    expect(t.rows[1]).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "bob", style: { bold: true } }],
          },
        ],
      },
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "link", url: "https://e.com", text: "site" }],
          },
        ],
      },
    ]);
  });

  test("degrades an image in a formatted cell to a link, keeping the URL", () => {
    const table = [
      "| Name | Logo |",
      "| --- | --- |",
      "| **acme** | ![logo](https://e.com/l.png) |",
    ].join("\n");
    const t = renderSlackBlocks(table)![0] as TableBlock;
    expect(t.rows[1]![1]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "link", url: "https://e.com/l.png", text: "logo" },
          ],
        },
      ],
    });
  });

  test("degrades a cell link with a relative/anchor URL to plain text", () => {
    const table = [
      "| Doc | Note |",
      "| --- | --- |",
      "| [README](./README.md) | [api](#api) |",
    ].join("\n");
    const t = renderSlackBlocks(table)![0] as TableBlock;
    expect(t.rows[1]).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "README" }],
          },
        ],
      },
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "api" }],
          },
        ],
      },
    ]);
  });

  test("keeps plain table cells as raw_text", () => {
    const table = ["| A | B |", "| --- | --- |", "| one | two |"].join("\n");
    const t = renderSlackBlocks(table)![0] as TableBlock;
    expect(t.rows[1]).toEqual([
      { type: "raw_text", text: "one" },
      { type: "raw_text", text: "two" },
    ]);
  });

  test("maps GFM column alignment to column_settings", () => {
    const table = [
      "| L | C | R | D |",
      "| :-- | :-: | --: | --- |",
      "| a | b | c | d |",
    ].join("\n");
    const t = renderSlackBlocks(table)![0] as TableBlock;
    expect(t.column_settings).toEqual([
      { align: "left" },
      { align: "center" },
      { align: "right" },
      {},
    ]);
  });

  test("omits column_settings when no column is aligned", () => {
    const table = ["| A | B |", "| --- | --- |", "| a | b |"].join("\n");
    const t = renderSlackBlocks(table)![0] as TableBlock;
    expect(t.column_settings).toBeUndefined();
  });

  test("renders a standalone image as an image block", () => {
    const blocks = renderSlackBlocks("![a cat](https://example.com/cat.png)");
    expect(blocks).toEqual([
      {
        type: "image",
        image_url: "https://example.com/cat.png",
        alt_text: "a cat",
      },
    ]);
  });

  test("keeps an image inline with prose in the markdown block", () => {
    const blocks = renderSlackBlocks(
      "Look: ![a cat](https://example.com/cat.png) cute.",
    );
    expect(blocks).toEqual([
      {
        type: "markdown",
        text: "Look: ![a cat](https://example.com/cat.png) cute.",
      },
    ]);
  });

  test("truncates image alt_text to Slack's 2000-char cap", () => {
    const alt = "x".repeat(2500);
    const blocks = renderSlackBlocks(`![${alt}](https://example.com/cat.png)`);
    const image = blocks![0] as ImageBlock;
    expect(image.type).toBe("image");
    expect(image.alt_text).toBe("x".repeat(2000));
  });

  test("falls back to a non-empty alt_text for an image with no alt", () => {
    const blocks = renderSlackBlocks("![](https://example.com/cat.png)");
    const image = blocks![0] as ImageBlock;
    expect(image.type).toBe("image");
    expect(image.alt_text).toBe("image");
  });

  test("leaves a non-hostable image URL in the markdown block", () => {
    const blocks = renderSlackBlocks("![x](/relative/path.png)");
    expect(blocks).toEqual([
      { type: "markdown", text: "![x](/relative/path.png)" },
    ]);
  });

  test("falls back a formatted heading to a markdown block", () => {
    const blocks = renderSlackBlocks("## See the [docs](https://e.com)");
    expect(blocks).toEqual([
      { type: "markdown", text: "## See the [docs](https://e.com)" },
    ]);
  });

  test("falls back an over-150-char heading to a markdown block", () => {
    const long = "# " + "x".repeat(151);
    const blocks = renderSlackBlocks(long);
    expect(blocks).toEqual([{ type: "markdown", text: long }]);
  });

  test("does not treat a lone pipe in prose as a table", () => {
    const blocks = renderSlackBlocks("Use a | b in a sentence.");
    expect(blocks!.length).toBe(1);
    expect(blocks![0].type).toBe("markdown");
  });

  test("falls back to markdown when a table exceeds the column limit", () => {
    const cols = 21;
    const header = Array.from({ length: cols }, (_, i) => `H${i}`);
    const data = Array.from({ length: cols }, (_, i) => `v${i}`);
    const table = [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      `| ${data.join(" | ")} |`,
    ].join("\n");
    const blocks = renderSlackBlocks(table);
    expect(blocks!.some((b) => b.type === "table")).toBe(false);
    expect(blocks!.every((b) => b.type === "markdown")).toBe(true);
  });

  test("falls back to markdown when one table's cells exceed 10k chars", () => {
    const big = "x".repeat(10_001);
    const table = ["| H | V |", "| --- | --- |", `| a | ${big} |`].join("\n");
    const blocks = renderSlackBlocks(table);
    expect(blocks!.some((b) => b.type === "table")).toBe(false);
  });

  test("counts an empty-alt image cell's emitted URL toward the 10k budget", () => {
    const url = "https://e.com/" + "x".repeat(10_001);
    const table = ["| H | V |", "| --- | --- |", `| a | ![](${url}) |`].join(
      "\n",
    );
    const blocks = renderSlackBlocks(table);
    expect(blocks!.some((b) => b.type === "table")).toBe(false);
  });

  test("falls back later tables once the per-message 10k cell budget is spent", () => {
    const big = "x".repeat(6000);
    const tableA = ["| H | V |", "| --- | --- |", `| a | ${big} |`].join("\n");
    const tableB = ["| H | V |", "| --- | --- |", `| b | ${big} |`].join("\n");
    const blocks = renderSlackBlocks(`${tableA}\n\n${tableB}`);
    // First table fits; the second pushes the aggregate over 10k → markdown.
    expect(blocks!.filter((b) => b.type === "table").length).toBe(1);
    expect(blocks!.some((b) => b.type === "markdown")).toBe(true);
  });

  test("emits one block per element with no whole-message cap (transport owns size)", () => {
    // The renderer does not police total block count — Slack's 50-block limit is
    // the transport's concern (it resends as plain text on rejection). 60
    // headings render as 60 header blocks, not a truncated-with-note set.
    const text = Array.from({ length: 60 }, (_, i) => `# H${i}`).join("\n\n");
    const blocks = renderSlackBlocks(text);
    expect(blocks!.length).toBe(60);
    expect(blocks!.every((b) => b.type === "header")).toBe(true);
  });

  test("keeps an oversized run in a single markdown block (no chunking)", () => {
    // A run over Slack's 12k per-block limit is left whole rather than split
    // mid-content; the transport degrades to plain text if Slack rejects it.
    const para = "word ".repeat(3000).trim();
    expect(para.length).toBeGreaterThan(12_000);
    const blocks = renderSlackBlocks(para);
    expect(blocks).toEqual([{ type: "markdown", text: para }]);
  });
});
