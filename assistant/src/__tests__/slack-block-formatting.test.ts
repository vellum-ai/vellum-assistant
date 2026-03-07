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
