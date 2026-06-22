import { describe, expect, test } from "bun:test";

import { stripMediaPayloadsForRetry } from "../daemon/conversation-media-retry.js";
import { createContextSummaryMessage } from "../plugins/defaults/compaction/window-manager.js";
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

function makeImageBlockWithSize(
  dataLength: number,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "A".repeat(dataLength),
    },
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
      makeUserMessage(
        { type: "text", text: "older kept turn" },
        makeImageBlock("AAAA"),
      ),
      makeAssistantMessage({ type: "text", text: "response" }),
      makeUserMessage(
        { type: "text", text: "latest kept turn" },
        makeImageBlock("BBBB"),
      ),
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

  // ---------------------------------------------------------------------------
  // Budget-aware media retention
  // ---------------------------------------------------------------------------

  test("budget-aware: keeps images that fit within token budget", () => {
    // Dimension-based estimation: when the base64 data has no parseable image
    // header, fall back to IMAGE_MAX_TOKENS (1600) + overhead (~19 tokens) ≈
    // 1619 tokens/image. Budget of 5000 allows 3 images (3 * 1619 = 4857
    // <= 5000) but not 4 (4 * 1619 = 6476 > 5000).
    const images = Array.from({ length: 5 }, () =>
      makeImageBlockWithSize(4000),
    );
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "describe these" }, ...images),
    ];

    const result = stripMediaPayloadsForRetry(messages, {
      mediaTokenBudget: 5000,
      providerName: "mock",
    });
    expect(result.modified).toBe(true);

    const content = result.messages[0].content;
    const keptImages = content.filter((b) => b.type === "image");
    const stubs = content.filter(
      (b) =>
        b.type === "text" &&
        (b as { text: string }).text.includes("Image omitted"),
    );
    expect(keptImages.length).toBe(3);
    expect(stubs.length).toBe(2);
  });

  test("budget-aware: keeps all images when budget is generous", () => {
    const images = Array.from({ length: 3 }, () => makeImageBlockWithSize(100));
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "describe these" }, ...images),
    ];

    const result = stripMediaPayloadsForRetry(messages, {
      mediaTokenBudget: 100_000,
      providerName: "mock",
    });
    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);

    const content = result.messages[0].content;
    const keptImages = content.filter((b) => b.type === "image");
    expect(keptImages.length).toBe(3);
  });

  test("budget-aware: stubs all when budget is zero", () => {
    const images = Array.from({ length: 3 }, () => makeImageBlockWithSize(100));
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "describe these" }, ...images),
    ];

    const result = stripMediaPayloadsForRetry(messages, {
      mediaTokenBudget: 0,
      providerName: "mock",
    });
    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(3);

    const content = result.messages[0].content;
    const keptImages = content.filter((b) => b.type === "image");
    expect(keptImages.length).toBe(0);
  });

  test("no options falls back to hardcoded limit", () => {
    const images = Array.from({ length: 5 }, () => makeImageBlockWithSize(100));
    const messages: Message[] = [
      makeUserMessage({ type: "text", text: "describe these" }, ...images),
    ];

    const result = stripMediaPayloadsForRetry(messages);
    expect(result.modified).toBe(true);

    const content = result.messages[0].content;
    const keptImages = content.filter((b) => b.type === "image");
    const stubs = content.filter(
      (b) =>
        b.type === "text" &&
        (b as { text: string }).text.includes("Image omitted"),
    );
    expect(keptImages.length).toBe(3);
    expect(stubs.length).toBe(2);
  });
});
