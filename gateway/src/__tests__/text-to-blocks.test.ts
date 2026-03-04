import { describe, test, expect } from "bun:test";
import { textToBlocks } from "../slack/text-to-blocks.js";

describe("textToBlocks", () => {
  test("returns empty array for empty string", () => {
    expect(textToBlocks("")).toEqual([]);
    expect(textToBlocks("   ")).toEqual([]);
  });

  test("converts plain text into a single section block", () => {
    const blocks = textToBlocks("Hello, world!");
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Hello, world!" } },
    ]);
  });

  test("converts markdown heading to header block", () => {
    const blocks = textToBlocks("# Welcome\n\nSome content here.");
    expect(blocks).toHaveLength(3); // header, divider, section
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Welcome", emoji: true },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Some content here." },
    });
  });

  test("wraps fenced code blocks in triple backticks", () => {
    const input = "Here is code:\n\n```js\nconsole.log('hi');\n```";
    const blocks = textToBlocks(input);

    expect(blocks).toHaveLength(3); // text, divider, code
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Here is code:" },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```js\nconsole.log('hi');\n```",
      },
    });
  });

  test("converts markdown links to Slack mrkdwn format", () => {
    const blocks = textToBlocks("Check [this link](https://example.com).");
    expect(blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Check <https://example.com|this link>.",
      },
    });
  });

  test("converts **bold** to *bold*", () => {
    const blocks = textToBlocks("This is **important**.");
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "This is *important*." },
    });
  });

  test("inserts dividers between multiple sections", () => {
    const input =
      "# Title\n\nFirst paragraph.\n\n## Subtitle\n\nSecond paragraph.";
    const blocks = textToBlocks(input);

    // header, divider, section, divider, header, divider, section
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "header",
      "divider",
      "section",
      "divider",
      "header",
      "divider",
      "section",
    ]);
  });

  test("handles code block without language specifier", () => {
    const input = "```\nplain code\n```";
    const blocks = textToBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "```\nplain code\n```" },
    });
  });

  test("handles mixed content with multiple code blocks", () => {
    const input =
      "Intro text.\n\n```python\nprint('hello')\n```\n\nMiddle text.\n\n```\nmore code\n```";
    const blocks = textToBlocks(input);

    const types = blocks.map((b) => b.type);
    // text, divider, code, divider, text, divider, code
    expect(types).toEqual([
      "section",
      "divider",
      "section",
      "divider",
      "section",
      "divider",
      "section",
    ]);
  });

  test("parses code fence languages with special characters (c++, c#, f#)", () => {
    const input = "```c++\nint main() {}\n```";
    const blocks = textToBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "```c++\nint main() {}\n```" },
    });

    const input2 = "```c#\nConsole.WriteLine();\n```";
    const blocks2 = textToBlocks(input2);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```c#\nConsole.WriteLine();\n```",
      },
    });
  });

  test("splits oversized text sections at 3000-char limit", () => {
    // Build a string with many lines that exceeds 3000 chars total
    const line = "x".repeat(100) + "\n";
    const longText = line.repeat(40).trimEnd(); // 40 * 101 = 4040 chars
    const blocks = textToBlocks(longText);

    // Should be split into multiple sections with dividers between them
    expect(blocks.length).toBeGreaterThanOrEqual(3); // at least 2 sections + 1 divider
    for (const block of blocks) {
      if (block.type === "section") {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
  });

  test("splits oversized code block at 3000-char limit", () => {
    const codeLine = "console.log('hello');\n";
    // ~22 chars per line, need >3000 chars total including fences
    const codeContent = codeLine.repeat(150).trimEnd(); // ~3300 chars
    const input = "```js\n" + codeContent + "\n```";
    const blocks = textToBlocks(input);

    for (const block of blocks) {
      if (block.type === "section") {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
  });
});
