import { describe, expect, test } from "bun:test";

import { getSlackConversationDisplay } from "@/domains/chat/utils/slack-conversation-display";

describe("getSlackConversationDisplay", () => {
  test("returns null for Slack-origin conversations without binding data", () => {
    expect(
      getSlackConversationDisplay({
        conversation: {
          originChannel: "slack",
        },
      }),
    ).toBeNull();
  });

  test("returns a display for Slack-origin conversations with binding data", () => {
    expect(
      getSlackConversationDisplay({
        conversation: {
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C0123ABCDEF",
            externalChatName: "product",
          },
        },
      })?.displayText,
    ).toBe("product");
  });
});
