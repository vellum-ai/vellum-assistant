import { describe, expect, test } from "bun:test";

import type {
  ConversationContentBlock,
  ConversationMessage,
} from "@vellumai/assistant-api";

import { summarizeRuntimeMessage } from "./diagnostics";

function runtimeMessage(
  contentBlocks: ConversationContentBlock[],
): ConversationMessage {
  return {
    id: "message-123",
    role: "assistant",
    timestamp: "2026-07-23T00:00:00.000Z",
    attachments: [],
    contentBlocks,
  };
}

describe("chat diagnostic content-block sizing", () => {
  test("preserves serialized UTF-8 size semantics for ordinary content", () => {
    const contentBlocks: ConversationContentBlock[] = [
      { type: "text", text: "Hello, 👋\n\"world\"" },
      {
        type: "thinking",
        thinking: "résumé",
        startedAt: 1,
        completedAt: 2,
      },
    ];
    const expectedBytes = new TextEncoder().encode(
      JSON.stringify(contentBlocks),
    ).length;

    const summary = summarizeRuntimeMessage(runtimeMessage(contentBlocks));

    expect(summary.contentBlocksKb).toBe(
      Math.round((expectedBytes / 1024) * 100) / 100,
    );
    expect(summary.inlineMediaKb).toBe(0);
    expect(summary.inlineMediaCount).toBe(0);
  });

  test("measures large nested attachment and tool-result media separately", () => {
    const attachmentData = "A".repeat(512 * 1024);
    const thumbnailData = "B".repeat(256 * 1024);
    const deprecatedToolImage = "C".repeat(512 * 1024);
    const toolImages = ["D".repeat(512 * 1024), "E".repeat(512 * 1024)];
    const contentBlocks: ConversationContentBlock[] = [
      {
        type: "attachment",
        attachment: {
          id: "attachment-123",
          filename: "image.png",
          mimeType: "image/png",
          sizeBytes: attachmentData.length,
          kind: "image",
          data: attachmentData,
          thumbnailData,
        },
      },
      {
        type: "tool_use",
        toolCall: {
          id: "tool-123",
          name: "browser_screenshot",
          input: {},
          imageData: deprecatedToolImage,
          imageDataList: toolImages,
        },
      },
    ];
    const inlineMediaBytes =
      attachmentData.length +
      thumbnailData.length +
      deprecatedToolImage.length +
      toolImages.reduce((total, image) => total + image.length, 0);
    const summary = summarizeRuntimeMessage(runtimeMessage(contentBlocks));

    expect(summary.inlineMediaCount).toBe(5);
    expect(summary.inlineMediaKb).toBe(inlineMediaBytes / 1024);
    expect(summary.contentBlocksKb).toBeGreaterThan(summary.inlineMediaKb as number);
    expect(summary.contentBlocksKb).toBeLessThan(
      (summary.inlineMediaKb as number) + 1,
    );
  });
});
