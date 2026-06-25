import { describe, expect, test } from "bun:test";

import { getChannelBindingDisplayText } from "@/domains/chat/utils/channel-conversation-display";

describe("getChannelBindingDisplayText", () => {
  test("prefers the external chat name", () => {
    expect(
      getChannelBindingDisplayText({
        sourceChannel: "telegram",
        externalChatId: "123",
        externalChatName: "Team Chat",
        displayName: "Alice",
        username: "alice",
      }),
    ).toBe("Team Chat");
  });

  test("falls back to display name, then username", () => {
    expect(
      getChannelBindingDisplayText({
        sourceChannel: "telegram",
        externalChatId: "123",
        displayName: "Alice",
        username: "alice",
      }),
    ).toBe("Alice");

    expect(
      getChannelBindingDisplayText({
        sourceChannel: "telegram",
        externalChatId: "123",
        username: "alice",
      }),
    ).toBe("alice");
  });

  test("never surfaces the raw external chat id as a label", () => {
    expect(
      getChannelBindingDisplayText({
        sourceChannel: "telegram",
        externalChatId: "123456789",
        externalChatName: "123456789",
      }),
    ).toBeUndefined();
  });

  test("returns undefined when no friendly name is available", () => {
    expect(
      getChannelBindingDisplayText({
        sourceChannel: "phone",
        externalChatId: "+15551234567",
      }),
    ).toBeUndefined();
    expect(getChannelBindingDisplayText(undefined)).toBeUndefined();
  });

  test("ignores blank-only names", () => {
    expect(
      getChannelBindingDisplayText({
        sourceChannel: "telegram",
        externalChatId: "123",
        externalChatName: "   ",
        displayName: "Alice",
      }),
    ).toBe("Alice");
  });
});
