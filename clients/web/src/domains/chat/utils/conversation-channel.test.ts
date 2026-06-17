import { describe, expect, test } from "bun:test";

import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";

describe("isChannelConversation", () => {
  test("returns false for an undefined or null conversation", () => {
    expect(isChannelConversation(undefined)).toBe(false);
    expect(isChannelConversation(null)).toBe(false);
  });

  test("returns false when no originChannel is set", () => {
    expect(isChannelConversation({ originChannel: undefined })).toBe(false);
  });

  test("returns false for the native 'vellum' channel", () => {
    expect(isChannelConversation({ originChannel: "vellum" })).toBe(false);
  });

  test("returns false for notification:* outbound-only channels", () => {
    expect(
      isChannelConversation({ originChannel: "notification:reminder" }),
    ).toBe(false);
    expect(isChannelConversation({ originChannel: "notification:slack" })).toBe(
      false,
    );
  });

  test("returns true for slack/telegram/phone external channels", () => {
    expect(isChannelConversation({ originChannel: "slack" })).toBe(true);
    expect(isChannelConversation({ originChannel: "telegram" })).toBe(true);
    expect(isChannelConversation({ originChannel: "phone" })).toBe(true);
  });
});
