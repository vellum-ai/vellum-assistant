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
      text: { type: "plain_text", text: "Welcome" },
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
});
