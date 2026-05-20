import { describe, expect, test } from "bun:test";

import { parseConversation } from "@/domains/chat/api/conversations.js";

describe("parseConversation — originChannel plumbing", () => {
  test("returns null for non-object input", () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation(undefined)).toBeNull();
    expect(parseConversation("string")).toBeNull();
  });

  test("returns null when no conversationKey/id is present", () => {
    expect(parseConversation({})).toBeNull();
  });

  test("leaves originChannel undefined when neither field is present", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      title: "Hello",
    });
    expect(parsed?.originChannel).toBeUndefined();
  });

  test("reads originChannel from conversationOriginChannel as a fallback", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("slack");
  });

  test("prefers channelBinding.sourceChannel over conversationOriginChannel", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      channelBinding: { sourceChannel: "telegram" },
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("telegram");
  });

  test("treats non-string channelBinding.sourceChannel as missing", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      channelBinding: { sourceChannel: 42 },
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("slack");
  });

  test("treats notification:* origin channel as a literal pass-through", () => {
    // `isChannelConversation` is the layer that excludes notification:*;
    // the parser must preserve the raw value as-is so the predicate can
    // make the decision.
    const parsed = parseConversation({
      conversationKey: "conv-123",
      conversationOriginChannel: "notification:reminder",
    });
    expect(parsed?.originChannel).toBe("notification:reminder");
  });
});
