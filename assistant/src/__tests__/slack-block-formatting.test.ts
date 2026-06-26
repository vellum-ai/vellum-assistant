import { describe, expect, test } from "bun:test";

import type { TableBlock } from "@slack/types";

import { textToSlackBlocks } from "../runtime/slack-block-formatting.js";

describe("textToSlackBlocks", () => {
  test("returns undefined for empty text", () => {
    expect(textToSlackBlocks("")).toBeUndefined();
    expect(textToSlackBlocks("   ")).toBeUndefined();
  });

  test("converts plain text to a single section block", () => {
    const blocks = textToSlackBlocks("Hello, world!");
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Hello, world!" } },
    ]);
  });

  test("converts heading to header block", () => {
    const blocks = textToSlackBlocks("# Title\n\nBody text.");
    expect(blocks).toBeDefined();
    expect(blocks![0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Title" },
    });
  });

  test("wraps fenced code in triple backticks", () => {
    const blocks = textToSlackBlocks("```ts\nconst x = 1;\n```");
    expect(blocks).toBeDefined();
    expect(blocks![0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "```ts\nconst x = 1;\n```" },
    });
  });

  test("converts markdown links to Slack format", () => {
    const blocks = textToSlackBlocks("See [docs](https://example.com).");
    expect(blocks).toBeDefined();
    expect(blocks![0].type).toBe("section");
    const sectionBlock = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(sectionBlock.text.text).toBe("See <https://example.com|docs>.");
  });

  test("converts **bold** to *bold*", () => {
    const blocks = textToSlackBlocks("**important**");
    expect(blocks).toBeDefined();
    const sectionBlock = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(sectionBlock.text.text).toBe("*important*");
  });

  test("inserts dividers between segments", () => {
    const blocks = textToSlackBlocks("# Heading\n\nParagraph.");
    expect(blocks).toBeDefined();
    const types = blocks!.map((b) => b.type);
    expect(types).toContain("divider");
  });

  test("renders a markdown table as a Slack table block", () => {
    const table = [
      "| Tool | Price | License |",
      "| --- | --- | --- |",
      "| Alpha | $10/mo | MIT |",
      "| Beta | $20/mo | Apache |",
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    // The header is emitted as the first row, then one row per data row.
    // Cells are `raw_text` elements; markdown inside a cell is not
    // re-rendered (rich-text cells would be a future enhancement).
    expect(blocks![0]).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Tool" },
          { type: "raw_text", text: "Price" },
          { type: "raw_text", text: "License" },
        ],
        [
          { type: "raw_text", text: "Alpha" },
          { type: "raw_text", text: "$10/mo" },
          { type: "raw_text", text: "MIT" },
        ],
        [
          { type: "raw_text", text: "Beta" },
          { type: "raw_text", text: "$20/mo" },
          { type: "raw_text", text: "Apache" },
        ],
      ],
    });
  });

  test("renders a table with surrounding text", () => {
    const input = [
      "Here are the results:",
      "",
      "| Name | Score |",
      "| --- | --- |",
      "| Alice | 95 |",
      "| Bob | 87 |",
      "",
      "That's the summary.",
    ].join("\n");

    const blocks = textToSlackBlocks(input);
    expect(blocks).toBeDefined();
    const types = blocks!.map((b) => b.type);
    // Should have: text section, divider, table, divider, text section
    expect(types).toEqual([
      "section",
      "divider",
      "table",
      "divider",
      "section",
    ]);
  });

  test("does not treat non-table pipe text as a table", () => {
    const text = "Use the command | grep to filter output.";
    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    expect(blocks![0].type).toBe("section");
  });

  test("handles escaped pipes in table cells", () => {
    const table = [
      "| Command | Description |",
      "| --- | --- |",
      "| cmd \\| grep | filters output |",
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    const tableBlock = blocks![0] as TableBlock;
    expect(tableBlock.type).toBe("table");
    // The escaped pipe should appear as a literal pipe in the cell value.
    expect(tableBlock.rows[1]).toEqual([
      { type: "raw_text", text: "cmd | grep" },
      { type: "raw_text", text: "filters output" },
    ]);
  });

  test("treats pipe after even backslashes as a real column separator", () => {
    // C:\\ ends with two backslashes (even count), so the trailing | is a
    // real column separator, not an escaped pipe.
    const table = [
      "| Path | Description |",
      "| --- | --- |",
      "| C:\\\\| a windows path |",
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    const tableBlock = blocks![0] as TableBlock;
    expect(tableBlock.type).toBe("table");
    // C:\\ should be its own cell, "a windows path" in the Description column.
    expect(tableBlock.rows[1]).toEqual([
      { type: "raw_text", text: "C:\\\\" },
      { type: "raw_text", text: "a windows path" },
    ]);
  });

  test("pads short rows and substitutes a space for empty cells", () => {
    // The second data row is missing its third cell, and the third row has an
    // empty leading cell. Every row must still emit a cell for each column,
    // and empty cells become a single space because Slack's `raw_text`
    // element requires at least one character.
    const table = [
      "| A | B | C |",
      "| --- | --- | --- |",
      "| 1 | 2 | 3 |",
      "| 4 | 5 |",
      "|  | 8 | 9 |",
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    const tableBlock = blocks![0] as TableBlock;
    expect(tableBlock.type).toBe("table");
    // Short row padded to 3 cells, trailing cell filled with a space.
    expect(tableBlock.rows[2]).toEqual([
      { type: "raw_text", text: "4" },
      { type: "raw_text", text: "5" },
      { type: "raw_text", text: " " },
    ]);
    // Empty leading cell also becomes a space.
    expect(tableBlock.rows[3][0]).toEqual({ type: "raw_text", text: " " });
  });

  test("falls back to text sections when a table exceeds Slack's column limit", () => {
    // Slack table blocks allow at most 20 columns. A 21-column table must
    // degrade to the structured-text rendering rather than emit an invalid
    // table block.
    const columns = 21;
    const headerCells = Array.from({ length: columns }, (_, i) => `H${i}`);
    const dataCells = Array.from({ length: columns }, (_, i) => `v${i}`);
    const table = [
      `| ${headerCells.join(" | ")} |`,
      `| ${headerCells.map(() => "---").join(" | ")} |`,
      `| ${dataCells.join(" | ")} |`,
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.some((b) => b.type === "table")).toBe(false);
    expect(
      blocks!.every((b) => b.type === "section" || b.type === "divider"),
    ).toBe(true);
  });

  test("falls back to text sections when table cell content exceeds Slack's character cap", () => {
    // Slack caps total cell characters per table at 10,000. A table within the
    // row/column limits but with an oversize cell must degrade to structured
    // text rather than emit a table block Slack would reject as invalid_blocks.
    const huge = "x".repeat(10_001);
    const table = [
      "| Name | Notes |",
      "| --- | --- |",
      `| Alpha | ${huge} |`,
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.some((b) => b.type === "table")).toBe(false);
    expect(
      blocks!.every((b) => b.type === "section" || b.type === "divider"),
    ).toBe(true);
  });

  test("requires header + separator + data row for table detection", () => {
    // Only header and separator, no data rows
    const input = "| A | B |\n| --- | --- |";
    const blocks = textToSlackBlocks(input);
    expect(blocks).toBeDefined();
    // Should be treated as plain text, not a table
    const section = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(section.text.text).toContain("|");
  });
});
