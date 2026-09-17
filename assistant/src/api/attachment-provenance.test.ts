import { describe, expect, test } from "bun:test";

import { AssistantOutboundAttachmentSchema } from "./events/assistant-outbound-attachment.js";
import { ConversationMessageAttachmentSchema } from "./responses/conversation-message.js";

const outboundFixture = {
  id: "attachment-1",
  filename: "screenshot.png",
  mimeType: "image/png",
  data: "c2NyZWVuc2hvdA==",
  sourceType: "tool_block" as const,
};

const historyFixture = {
  id: "attachment-1",
  filename: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 10,
  kind: "image",
};

describe("computer-use screenshot attachment provenance", () => {
  test("new schemas accept the marker and its absence", () => {
    expect(
      AssistantOutboundAttachmentSchema.parse({
        ...outboundFixture,
        computerUseScreenshot: true,
      }).computerUseScreenshot,
    ).toBe(true);
    expect(
      AssistantOutboundAttachmentSchema.parse(outboundFixture)
        .computerUseScreenshot,
    ).toBeUndefined();

    expect(
      ConversationMessageAttachmentSchema.parse({
        ...historyFixture,
        computerUseScreenshot: true,
      }).computerUseScreenshot,
    ).toBe(true);
    expect(
      ConversationMessageAttachmentSchema.parse(historyFixture)
        .computerUseScreenshot,
    ).toBeUndefined();
  });

  test("legacy object parsers tolerate and strip the additive marker", () => {
    const legacyOutbound = AssistantOutboundAttachmentSchema.omit({
      computerUseScreenshot: true,
    });
    const legacyHistory = ConversationMessageAttachmentSchema.omit({
      computerUseScreenshot: true,
    });

    expect(
      legacyOutbound.parse({
        ...outboundFixture,
        computerUseScreenshot: true,
      }),
    ).toEqual(outboundFixture);
    expect(
      legacyHistory.parse({
        ...historyFixture,
        computerUseScreenshot: true,
      }),
    ).toEqual(historyFixture);
  });
});
