import { describe, expect, test } from "bun:test";

import {
  type ConversationMessageAttachment,
  type ConversationMessageSurface,
  type ConversationMessageToolCall,
  deriveContentBlocks,
} from "./conversation-message.js";

const toolCall: ConversationMessageToolCall = {
  name: "run_command",
  input: { command: "ls" },
  result: "file.txt",
};

const surface: ConversationMessageSurface = {
  surfaceId: "s1",
  surfaceType: "ui_card",
  data: {},
};

const attachment: ConversationMessageAttachment = {
  id: "a1",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 10,
  kind: "image",
};

describe("deriveContentBlocks", () => {
  test("maps interleaved content order into ordered tagged blocks", () => {
    // GIVEN a row whose positional contentOrder interleaves every block kind
    const row = {
      contentOrder: [
        "text:0",
        "thinking:0",
        "tool:0",
        "surface:0",
        "attachment:0",
        "text:1",
      ],
      textSegments: ["before tool", "after tool"],
      thinkingSegments: ["reasoning"],
      toolCalls: [toolCall],
      surfaces: [surface],
      attachments: [attachment],
    };

    // WHEN we derive the unified content blocks
    const blocks = deriveContentBlocks(row);

    // THEN each ref resolves to its block in contentOrder order
    expect(blocks).toEqual([
      { type: "text", text: "before tool" },
      { type: "thinking", thinking: "reasoning" },
      { type: "tool_use", toolCall },
      { type: "surface", surface },
      { type: "attachment", attachment },
      { type: "text", text: "after tool" },
    ]);
  });

  test("tool_use blocks carry the already-paired tool call", () => {
    // GIVEN a tool ref pointing at a tool call that already has its result
    const row = { contentOrder: ["tool:0"], toolCalls: [toolCall] };

    // WHEN we derive blocks
    const [block] = deriveContentBlocks(row);

    // THEN the block reuses the cleaned tool call (result merged in)
    expect(block).toEqual({ type: "tool_use", toolCall });
    expect(block?.type === "tool_use" && block.toolCall.result).toBe(
      "file.txt",
    );
  });

  test("preserves empty-string text segments", () => {
    // GIVEN a text ref pointing at an empty (but present) segment
    const row = { contentOrder: ["text:0"], textSegments: [""] };

    // WHEN we derive blocks
    const blocks = deriveContentBlocks(row);

    // THEN the empty segment is kept (only missing segments are skipped)
    expect(blocks).toEqual([{ type: "text", text: "" }]);
  });

  test("skips refs whose index is out of range", () => {
    // GIVEN refs that point past the end of their backing arrays
    const row = {
      contentOrder: ["text:5", "tool:2", "text:0"],
      textSegments: ["only"],
      toolCalls: [toolCall],
    };

    // WHEN we derive blocks
    const blocks = deriveContentBlocks(row);

    // THEN only the resolvable ref produces a block
    expect(blocks).toEqual([{ type: "text", text: "only" }]);
  });

  test("skips unknown kinds and malformed entries", () => {
    // GIVEN entries with an unknown kind, no separator, and a negative index
    const row = {
      contentOrder: ["mystery:0", "text", "text:-1", "text:0"],
      textSegments: ["kept"],
    };

    // WHEN we derive blocks
    const blocks = deriveContentBlocks(row);

    // THEN only the well-formed, in-range text ref survives
    expect(blocks).toEqual([{ type: "text", text: "kept" }]);
  });

  test("returns an empty array when contentOrder is absent", () => {
    // GIVEN a row with no contentOrder
    const row = { textSegments: ["orphan"] };

    // WHEN we derive blocks
    const blocks = deriveContentBlocks(row);

    // THEN nothing is emitted (contentOrder drives the projection)
    expect(blocks).toEqual([]);
  });
});
