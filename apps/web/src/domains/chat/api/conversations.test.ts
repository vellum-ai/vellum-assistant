import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/domains/chat/api/client.js";
import { listConversations, parseConversation } from "@/domains/chat/api/conversations.js";

describe("parseConversation — originChannel plumbing", () => {
  test("returns null for non-object input", () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation(undefined)).toBeNull();
    expect(parseConversation("string")).toBeNull();
  });

  test("returns null when no conversationId/id is present", () => {
    expect(parseConversation({})).toBeNull();
  });

  test("leaves originChannel undefined when neither field is present", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
      title: "Hello",
    });
    expect(parsed?.originChannel).toBeUndefined();
  });

  test("reads originChannel from conversationOriginChannel as a fallback", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("slack");
  });

  test("prefers channelBinding.sourceChannel over conversationOriginChannel", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
      channelBinding: { sourceChannel: "telegram" },
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("telegram");
  });

  test("treats non-string channelBinding.sourceChannel as missing", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
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
      conversationId: "conv-123",
      conversationOriginChannel: "notification:reminder",
    });
    expect(parsed?.originChannel).toBe("notification:reminder");
  });

  test("preserves Slack channel binding with id, name, and link", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
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
        conversationId: "conv-123",
        channelBinding: "slack",
      })?.channelBinding,
    ).toBeUndefined();

    const parsed = parseConversation({
      conversationId: "conv-456",
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

describe("parseConversation — displayOrder", () => {
  test("captures numeric displayOrder for drag-reordered conversations", () => {
    const parsed = parseConversation({
      conversationId: "conv-pinned",
      isPinned: true,
      displayOrder: 3,
    });
    expect(parsed?.displayOrder).toBe(3);
  });

  test("leaves displayOrder undefined when the field is absent", () => {
    const parsed = parseConversation({ conversationId: "conv-fresh" });
    expect(parsed?.displayOrder).toBeUndefined();
  });

  test("treats non-finite displayOrder as missing", () => {
    expect(
      parseConversation({
        conversationId: "c1",
        displayOrder: Number.NaN,
      })?.displayOrder,
    ).toBeUndefined();
    expect(
      parseConversation({
        conversationId: "c2",
        displayOrder: "0",
      })?.displayOrder,
    ).toBeUndefined();
  });
});

describe("listConversations — pagination", () => {
  const originalGet = client.get;
  type GetOptions = {
    query?: Record<string, unknown>;
  };

  type Page = {
    conversations: Array<{ conversationId: string }>;
    hasMore?: boolean;
  };

  function setupPagedResponses(pages: {
    foreground: Page[];
    background?: Page[];
  }): { calls: Array<{ url: unknown; query: Record<string, unknown> | undefined }> } {
    const calls: Array<{ url: unknown; query: Record<string, unknown> | undefined }> = [];
    const foregroundQueue = [...pages.foreground];
    const backgroundQueue = [...(pages.background ?? [{ conversations: [] }])];
    client.get = mock(
      async (options: GetOptions & { url?: unknown }) => {
        calls.push({ url: options.url, query: options.query });
        const isBackground = options.query?.conversationType === "background";
        const queue = isBackground ? backgroundQueue : foregroundQueue;
        const next = queue.shift() ?? { conversations: [], hasMore: false };
        return {
          data: next,
          error: null,
          response: new Response(null, { status: 200 }),
        };
      },
    ) as typeof client.get;
    return { calls };
  }

  afterEach(() => {
    client.get = originalGet;
  });

  test("loops over pages until hasMore is false (>50 conversations preserved)", async () => {
    const page1Items = Array.from({ length: 50 }, (_, i) => ({
      conversationId: `foreground-${i}`,
    }));
    const page2Items = Array.from({ length: 30 }, (_, i) => ({
      conversationId: `foreground-${50 + i}`,
    }));
    const { calls } = setupPagedResponses({
      foreground: [
        { conversations: page1Items, hasMore: true },
        { conversations: page2Items, hasMore: false },
      ],
    });

    const result = await listConversations("assistant-1");

    expect(result).toHaveLength(80);
    expect(result.at(0)?.conversationId).toBe("foreground-0");
    expect(result.at(-1)?.conversationId).toBe("foreground-79");
    // 2 foreground pages + 1 background page (empty by default). Foreground
    // and background fetch in parallel via Promise.allSettled, so filter
    // before asserting page offsets.
    expect(calls).toHaveLength(3);
    const foregroundCalls = calls.filter(
      (c) => c.query?.conversationType === undefined,
    );
    expect(foregroundCalls).toHaveLength(2);
    expect(foregroundCalls[0]?.query).toMatchObject({ limit: 50, offset: 0 });
    expect(foregroundCalls[1]?.query).toMatchObject({ limit: 50, offset: 50 });
  });

  test("stops on the first page when hasMore is false or absent", async () => {
    const { calls } = setupPagedResponses({
      foreground: [
        { conversations: [{ conversationId: "only-one" }] },
      ],
    });

    const result = await listConversations("assistant-1");

    expect(result).toHaveLength(1);
    // 1 foreground + 1 background
    expect(calls).toHaveLength(2);
  });

  test("does not loop forever on hasMore=true with empty page", async () => {
    const { calls } = setupPagedResponses({
      foreground: [
        { conversations: [{ conversationId: "a" }], hasMore: true },
        { conversations: [], hasMore: true },
      ],
    });

    const result = await listConversations("assistant-1");

    expect(result).toHaveLength(1);
    expect(calls).toHaveLength(3); // 2 foreground + 1 background
  });
});

describe("parseConversation — Slack channel binding", () => {
  test("preserves Slack channel binding with id, name, and link", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
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
            webUrl: "https://example.slack.com/archives/C0123ABCDEF/p1710000000000100",
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
          webUrl: "https://example.slack.com/archives/C0123ABCDEF/p1710000000000100",
        },
      },
    });
  });

  test("falls back to conversationOriginChannel when channelBinding is absent", () => {
    const parsed = parseConversation({
      conversationId: "conv-123",
      conversationOriginChannel: "slack",
    });

    expect(parsed?.originChannel).toBe("slack");
    expect(parsed?.channelBinding).toBeUndefined();
  });

  test("preserves Slack actor identity fields on channel bindings", () => {
    const parsed = parseConversation({
      conversationId: "conv-dm",
      channelBinding: {
        sourceChannel: "slack",
        externalChatId: "D0123ABCDEF",
        externalUserId: "U0123ABCDEF",
        displayName: "Alice",
        username: "alice",
      },
    });

    expect(parsed?.channelBinding).toMatchObject({
      sourceChannel: "slack",
      externalChatId: "D0123ABCDEF",
      externalUserId: "U0123ABCDEF",
      displayName: "Alice",
      username: "alice",
    });
  });

  test("does not throw for malformed or absent channelBinding", () => {
    expect(
      parseConversation({
        conversationId: "conv-123",
        channelBinding: "slack",
      })?.channelBinding,
    ).toBeUndefined();

    const parsed = parseConversation({
      conversationId: "conv-456",
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
