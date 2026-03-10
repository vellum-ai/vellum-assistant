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

  test("strips images from older user turns, keeps images in latest kept turn", () => {
    // After compaction, images only exist in kept turns (not in summary messages).
    // Media retry should keep images in the latest user message and strip older ones.
    const messages: Message[] = [
      createContextSummaryMessage("Summary"),
      makeUserMessage({ type: "text", text: "older kept turn" }, makeImageBlock("AAAA")),
      makeAssistantMessage({ type: "text", text: "response" }),
      makeUserMessage({ type: "text", text: "latest kept turn" }, makeImageBlock("BBBB")),
    ];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(1);

    // Older kept turn image → stubbed
    const olderBlocks = result.messages[1].content;
    expect(olderBlocks.filter((b) => b.type === "image").length).toBe(0);

    // Latest kept turn image → kept
    const latestBlocks = result.messages[3].content;
    expect(latestBlocks.filter((b) => b.type === "image").length).toBe(1);
  });
});
