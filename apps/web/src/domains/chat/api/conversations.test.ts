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

  test("preserves Slack channel binding with id, name, and link", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      channelBinding: {
        sourceChannel: "slack",
        externalChatId: "C0123ABCDEF",
        externalThreadId: "1710000000.000100",
        externalChatName: "product",
        slackChannel: {
          id: "C0123ABCDEF",
          name: "product",
          link: "slack://channel?team=T0123&id=C0123ABCDEF",
        },
        slackThread: {
          channelId: "C0123ABCDEF",
          threadTs: "1710000000.000100",
          link: {
            appUrl: "slack://channel?team=T0123&id=C0123ABCDEF",
            webUrl:
              "https://example.slack.com/archives/C0123ABCDEF/p1710000000000100",
          },
        },
      },
      conversationOriginChannel: "vellum",
    });

    expect(parsed?.originChannel).toBe("slack");
    expect(parsed?.channelBinding).toEqual({
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000100",
      externalChatName: "product",
      slackChannel: {
        id: "C0123ABCDEF",
        name: "product",
        link: "slack://channel?team=T0123&id=C0123ABCDEF",
      },
      slackThread: {
        channelId: "C0123ABCDEF",
        threadTs: "1710000000.000100",
        link: {
          appUrl: "slack://channel?team=T0123&id=C0123ABCDEF",
          webUrl:
            "https://example.slack.com/archives/C0123ABCDEF/p1710000000000100",
        },
      },
    });
  });

  test("does not throw for malformed or absent channelBinding", () => {
    expect(
      parseConversation({
        conversationKey: "conv-123",
        channelBinding: "slack",
      })?.channelBinding,
    ).toBeUndefined();

    const parsed = parseConversation({
      conversationKey: "conv-456",
      channelBinding: {
        sourceChannel: "slack",
        externalChatId: 123,
        slackChannel: {
          id: 123,
          name: "product",
        },
      },
      conversationOriginChannel: "telegram",
    });

    expect(parsed?.originChannel).toBe("slack");
    expect(parsed?.channelBinding).toBeUndefined();
  });
});
