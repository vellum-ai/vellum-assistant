import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  messageCopyText,
  messagePlainText,
} from "@/domains/chat/utils/message-plain-text";

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

describe("a tool-gated turn's plain text", () => {
  /**
   * A `send_user_message` turn reaches the two views by different routes: live,
   * the daemon streams one delta per model call carrying that call's messages
   * already joined, and the fold lands it as one text block; from history, the
   * server projects each call into its own text block. Copy, the Copy button,
   * and the stall watchdog all read this one function, so the two routes must
   * agree byte for byte or a settled turn reads as server progress forever.
   */
  it("folds the same whether the messages arrive joined or as separate blocks", () => {
    const live: Pick<DisplayMessage, "contentBlocks"> = {
      // One delta, joined by the daemon before it left.
      contentBlocks: [{ type: "text", text: "Found it. Sending now." }],
    };
    const fromHistory: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "text", text: "Found it." },
        { type: "text", text: "Sending now." },
      ],
    };

    expect(messagePlainText(live)).toBe(messagePlainText(fromHistory));
    expect(messagePlainText(live)).toBe("Found it. Sending now.");
  });

  it("agrees across a turn split by tool work between two replies", () => {
    // Live: a delta, the tool run, then a second delta, so two text blocks.
    const live: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          toolCall: { id: "tc-1", name: "web_fetch", input: {} },
        },
        { type: "text", text: "All set." },
      ],
    };
    // History: the scratchpad projects to thinking, each call to its text.
    const fromHistory: Pick<DisplayMessage, "contentBlocks"> = {
      contentBlocks: [
        { type: "thinking", thinking: "private working notes" },
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          toolCall: { id: "tc-1", name: "web_fetch", input: {} },
        },
        { type: "text", text: "All set." },
      ],
    };

    expect(messagePlainText(live)).toBe(messagePlainText(fromHistory));
    expect(messagePlainText(live)).toBe("Checking. All set.");
  });

  it("is copyable when the tool carried the only user-visible text", () => {
    expect(
      messageCopyText({
        contentBlocks: [
          { type: "thinking", thinking: "private working notes" },
          { type: "text", text: "Here you go." },
        ],
      }),
    ).toBe("Here you go.");
  });
});

describe("messageCopyText", () => {
  it("offers nothing for a row deleted on its channel", () => {
    expect(
      messageCopyText({
        contentBlocks: [{ type: "text", text: "gone" }],
        deletedAt: 1725100001000,
      }),
    ).toBe("");
    expect(
      messageCopyText({ contentBlocks: [{ type: "text", text: "here" }] }),
    ).toBe("here");
  });
});
