import { describe, expect, test } from "bun:test";

import {
  isSlackCallbackUrl,
  textToSlackBlocks,
} from "../runtime/slack-block-formatting.js";

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

  test("converts markdown table to structured bullet points", () => {
    const table = [
      "| Tool | Price | License |",
      "| --- | --- | --- |",
      "| Alpha | $10/mo | MIT |",
      "| Beta | $20/mo | Apache |",
    ].join("\n");

    const blocks = textToSlackBlocks(table);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    const section = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("*Alpha*");
    expect(section.text.text).toContain("Price: $10/mo");
    expect(section.text.text).toContain("*Beta*");
    expect(section.text.text).toContain("License: Apache");
    // Should NOT contain pipe characters from the original table
    expect(section.text.text).not.toContain("|");
  });

  test("converts table with surrounding text", () => {
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
    // Should have: text section, divider, table section, divider, text section
    expect(types).toEqual([
      "section",
      "divider",
      "section",
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
    const section = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    // The escaped pipe should appear as a literal pipe in the cell value
    expect(section.text.text).toContain("cmd | grep");
    expect(section.text.text).toContain("Description: filters output");
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
    const section = blocks![0] as {
      type: "section";
      text: { type: string; text: string };
    };
    // C:\\ should be its own cell, "a windows path" in the Description column
    expect(section.text.text).toContain("C:\\\\");
    expect(section.text.text).toContain("Description: a windows path");
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

describe("isSlackCallbackUrl", () => {
  test("returns true for Slack deliver URLs", () => {
    expect(
      isSlackCallbackUrl(
        "http://127.0.0.1:7830/deliver/slack?threadTs=123&channel=C456",
      ),
    ).toBe(true);
  });

  test("returns true for bare Slack deliver path", () => {
    expect(isSlackCallbackUrl("http://localhost:7830/deliver/slack")).toBe(
      true,
    );
  });

  test("returns false for non-Slack URLs", () => {
    expect(isSlackCallbackUrl("http://localhost:7830/deliver/telegram")).toBe(
      false,
    );
  });

  test("returns false for invalid URLs", () => {
    expect(isSlackCallbackUrl("not-a-url")).toBe(false);
  });

  test("returns false for managed outbound URLs", () => {
    expect(
      isSlackCallbackUrl(
        "http://localhost:7830/v1/internal/managed-gateway/outbound-send/?route_id=r1&assistant_id=a1&source_channel=phone",
      ),
    ).toBe(false);
  });
});
