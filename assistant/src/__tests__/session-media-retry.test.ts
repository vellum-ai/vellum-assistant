import { describe, expect, test } from "bun:test";

import { createContextSummaryMessage } from "../context/window-manager.js";
import { stripMediaPayloadsForRetry } from "../daemon/session-media-retry.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageBlock(
  data = "AAAA",
  mediaType = "image/png",
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

function makeUserMessage(...blocks: ContentBlock[]): Message {
  return { role: "user", content: blocks };
}

function makeAssistantMessage(...blocks: ContentBlock[]): Message {
  return { role: "assistant", content: blocks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stripMediaPayloadsForRetry", () => {
  test("keeps images in the latest user message", () => {
    const img = makeImageBlock();
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "hello" }, img),
    ];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
  });

  test("strips images from older user messages", () => {
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "old" }, makeImageBlock()),
      makeAssistantMessage({ type: "text", text: "response" }),
      makeUserMessage({ type: "text", text: "new" }),
    ];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(1);
    // The image in the first message should be replaced with a text stub
    const firstMsg = result.messages[0];
    expect(firstMsg.content[1].type).toBe("text");
    expect(
      (firstMsg.content[1] as { type: "text"; text: string }).text,
    ).toContain("Image omitted");
  });

  test("keeps images in summary message when it is the only user message", () => {
    // This is the bug scenario: forced compaction with minKeepRecentUserTurns: 0
    // compacts everything, preserving images into the summary message. Media
    // stubbing should NOT strip those images since there's no other user message.
    const img = makeImageBlock();
    const summaryMsg = createContextSummaryMessage(
      "Prior conversation summary",
    );
    summaryMsg.content.push(
      {
        type: "text",
        text: "[The following images were uploaded by the user in earlier messages and are preserved for reference.]",
      },
      img,
    );

    const messages: Message[] = [summaryMsg];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
    // The image should still be present
    const imageBlocks = result.messages[0].content.filter(
      (b) => b.type === "image",
    );
    expect(imageBlocks.length).toBe(1);
  });

  test("keeps images in summary message when only other user messages are tool-result-only", () => {
    const img = makeImageBlock();
    const summaryMsg = createContextSummaryMessage("Summary");
    summaryMsg.content.push(img);

    const toolResultMsg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "result text",
        },
      ],
    };

    const messages: Message[] = [
      summaryMsg,
      makeAssistantMessage({ type: "text", text: "ok" }),
      toolResultMsg,
    ];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
  });

  test("prefers non-summary user message over summary when both exist", () => {
    const summaryImg = makeImageBlock("BBBB");
    const summaryMsg = createContextSummaryMessage("Summary");
    summaryMsg.content.push(summaryImg);

    const userImg = makeImageBlock("CCCC");
    const userMsg = makeUserMessage({ type: "text", text: "latest" }, userImg);

    const messages: Message[] = [
      summaryMsg,
      makeAssistantMessage({ type: "text", text: "response" }),
      userMsg,
    ];

    const result = stripMediaPayloadsForRetry(messages);
    // Summary image should be stripped, user image should be kept
    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(1);

    // Summary message image → stubbed
    const summaryBlocks = result.messages[0].content;
    const summaryImageBlocks = summaryBlocks.filter((b) => b.type === "image");
    expect(summaryImageBlocks.length).toBe(0);

    // Latest user message image → kept
    const userBlocks = result.messages[2].content;
    const userImageBlocks = userBlocks.filter((b) => b.type === "image");
    expect(userImageBlocks.length).toBe(1);
  });
});
