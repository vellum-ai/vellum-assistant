import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";

describe("messagePlainText", () => {
  it("joins consecutive text blocks, inserting a space only between non-whitespace boundaries", () => {
    // GIVEN a message whose text blocks abut without their own spacing
    const message: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "text", text: "Hello" },
        { type: "text", text: "world" },
      ],
    };

    // WHEN deriving its plain text
    const result = messagePlainText(message);

    // THEN a single space bridges the two blocks
    expect(result).toBe("Hello world");
  });

  it("does not insert a space when either boundary is already whitespace", () => {
    // GIVEN blocks that already carry leading/trailing whitespace
    const message: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
        { type: "text", text: "\nnext" },
      ],
    };

    // WHEN deriving its plain text
    const result = messagePlainText(message);

    // THEN no extra space is added at the already-whitespace boundaries
    expect(result).toBe("Hello world\nnext");
  });

  it("skips non-text blocks and joins only the text bodies", () => {
    // GIVEN a message interleaving thinking/tool/surface blocks with text
    const message: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "Answer:" },
        {
          type: "tool_use",
          toolCall: { id: "t1", name: "search", input: {} },
        },
        { type: "text", text: "done" },
      ],
    };

    // WHEN deriving its plain text
    const result = messagePlainText(message);

    // THEN only the text blocks contribute, joined with spacing
    expect(result).toBe("Answer: done");
  });

  it("returns an empty string when the message has no text blocks", () => {
    // GIVEN a message whose only block is a thinking block
    const message: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [{ type: "thinking", thinking: "reasoning" }],
    };

    // WHEN deriving its plain text
    const result = messagePlainText(message);

    // THEN the body is empty
    expect(result).toBe("");
  });

  it("returns an empty string when contentBlocks is empty or the message is undefined", () => {
    // GIVEN a contentless row and a missing message
    const empty: Pick<DisplayMessage, "contentBlocks"> = { contentBlocks: [] };

    // WHEN deriving plain text from each
    // THEN both yield an empty string
    expect(messagePlainText(empty)).toBe("");
    expect(messagePlainText(undefined)).toBe("");
  });
});
