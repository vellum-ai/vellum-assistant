import { describe, expect, test } from "bun:test";

import type { TableBlock } from "@slack/types";

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

  test("flattens inline formatting inside table cells to plain text", () => {
    const table = [
      "| Name | Link |",
      "| --- | --- |",
      "| **bob** | [site](https://e.com) |",
    ].join("\n");
    const blocks = renderSlackBlocks(table);
    const t = blocks![0] as TableBlock;
    expect(t.rows[1]).toEqual([
      { type: "raw_text", text: "bob" },
      { type: "raw_text", text: "site" },
    ]);
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

  test("falls back later tables once the per-message 10k cell budget is spent", () => {
    const big = "x".repeat(6000);
    const tableA = ["| H | V |", "| --- | --- |", `| a | ${big} |`].join("\n");
    const tableB = ["| H | V |", "| --- | --- |", `| b | ${big} |`].join("\n");
    const blocks = renderSlackBlocks(`${tableA}\n\n${tableB}`);
    // First table fits; the second pushes the aggregate over 10k → markdown.
    expect(blocks!.filter((b) => b.type === "table").length).toBe(1);
    expect(blocks!.some((b) => b.type === "markdown")).toBe(true);
  });

  test("caps output at Slack's 50-block limit with a truncation note", () => {
    const text = Array.from({ length: 60 }, (_, i) => `# H${i}`).join("\n\n");
    const blocks = renderSlackBlocks(text);
    expect(blocks!.length).toBe(50);
    expect(blocks![49].type).toBe("context");
    expect(JSON.stringify(blocks![49])).toContain("omitted");
  });
});
