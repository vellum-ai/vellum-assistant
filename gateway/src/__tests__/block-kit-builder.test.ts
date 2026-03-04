import { describe, test, expect } from "bun:test";
import { BlockKitBuilder } from "../slack/block-kit-builder.js";

describe("block-kit-builder", () => {
  describe("static entry points", () => {
    test("BlockKitBuilder.section() creates a mrkdwn section block", () => {
      expect(BlockKitBuilder.section("hello").toBlocks()).toEqual([
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
      ]);
    });

    test("BlockKitBuilder.divider() creates a divider block", () => {
      expect(BlockKitBuilder.divider().toBlocks()).toEqual([
        { type: "divider" },
      ]);
    });

    test("BlockKitBuilder.header() creates a plain_text header block", () => {
      expect(BlockKitBuilder.header("Title").toBlocks()).toEqual([
        {
          type: "header",
          text: { type: "plain_text", text: "Title", emoji: true },
        },
      ]);
    });
  });

  describe("BlockKitBuilder", () => {
    test("builds blocks via fluent API", () => {
      const blocks = new BlockKitBuilder()
        .header("Welcome")
        .section("Some *bold* text")
        .divider()
        .section("More content")
        .toBlocks();

      expect(blocks).toEqual([
        {
          type: "header",
          text: { type: "plain_text", text: "Welcome", emoji: true },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "Some *bold* text" },
        },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "More content" } },
      ]);
    });

    test("toBlocks() returns consistent results", () => {
      const builder = new BlockKitBuilder().section("test");
      const blocks1 = builder.toBlocks();
      const blocks2 = builder.toBlocks();
      expect(blocks1).toEqual(blocks2);
    });
  });
});
