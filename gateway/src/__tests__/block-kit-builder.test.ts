import { describe, test, expect } from "bun:test";
import {
  BlockKitBuilder,
  section,
  divider,
  header,
} from "../slack/block-kit-builder.js";

describe("block-kit-builder", () => {
  describe("helper functions", () => {
    test("section() creates a mrkdwn section block", () => {
      expect(section("hello")).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: "hello" },
      });
    });

    test("divider() creates a divider block", () => {
      expect(divider()).toEqual({ type: "divider" });
    });

    test("header() creates a plain_text header block", () => {
      expect(header("Title")).toEqual({
        type: "header",
        text: { type: "plain_text", text: "Title" },
      });
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
        { type: "header", text: { type: "plain_text", text: "Welcome" } },
        {
          type: "section",
          text: { type: "mrkdwn", text: "Some *bold* text" },
        },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "More content" } },
      ]);
    });

    test("toBlocks() returns a copy", () => {
      const builder = new BlockKitBuilder().section("test");
      const blocks1 = builder.toBlocks();
      const blocks2 = builder.toBlocks();
      expect(blocks1).toEqual(blocks2);
      expect(blocks1).not.toBe(blocks2);
    });

    test("addBlock() accepts arbitrary blocks", () => {
      const builder = new BlockKitBuilder();
      builder.addBlock({ type: "divider" });
      expect(builder.toBlocks()).toEqual([{ type: "divider" }]);
    });
  });
});
