import { describe, expect, test } from "bun:test";

import {
  type ConversationContentBlock,
  ConversationContentBlockSchema,
  type ConversationMessageAttachment,
  type ConversationMessageSurface,
  type ConversationMessageToolCall,
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

describe("ConversationContentBlockSchema", () => {
  test("accepts every block kind in the union", () => {
    // GIVEN one well-formed value per discriminant
    const blocks: ConversationContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "thinking", thinking: "reasoning" },
      { type: "tool_use", toolCall },
      { type: "surface", surface },
      { type: "attachment", attachment },
    ];

    // WHEN each is parsed against the canonical schema
    // THEN all parse and round-trip unchanged
    for (const block of blocks) {
      expect(ConversationContentBlockSchema.parse(block)).toEqual(block);
    }
  });

  test("rejects an unknown discriminant", () => {
    // GIVEN a block whose `type` is not part of the union
    const block = { type: "mystery", text: "hi" };

    // WHEN parsed
    // THEN the discriminated union rejects it
    expect(() => ConversationContentBlockSchema.parse(block)).toThrow();
  });

  test("rejects a block missing its payload", () => {
    // GIVEN a tool_use block with no toolCall payload
    const block = { type: "tool_use" };

    // WHEN parsed
    // THEN validation fails
    expect(() => ConversationContentBlockSchema.parse(block)).toThrow();
  });
});
