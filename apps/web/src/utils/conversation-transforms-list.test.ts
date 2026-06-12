import { describe, expect, test } from "bun:test";

import {
  toConversation,
  type RawConversationSummary,
} from "@/utils/conversation-transforms";

/**
 * Build a minimal valid `RawConversationSummary`. Callers override only the
 * fields relevant to the test; everything else gets sensible defaults.
 */
function makeRaw(
  overrides: Partial<RawConversationSummary> & { id: string },
): RawConversationSummary {
  return {
    title: "",
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: 0,
    conversationType: "standard",
    source: "vellum",
    groupId: "",
    isProcessing: false,
    ...overrides,
  } as RawConversationSummary;
}

// ---------------------------------------------------------------------------
// toConversation — field mapping
// ---------------------------------------------------------------------------

describe("toConversation — field mapping", () => {
  test("maps id to conversationId", () => {
    const result = toConversation(makeRaw({ id: "conv-123" }));
    expect(result.conversationId).toBe("conv-123");
  });

  test("passes through epoch-ms timestamps", () => {
    const result = toConversation(
      makeRaw({ id: "c", createdAt: 1710000000000, updatedAt: 1710000060000 }),
    );
    expect(result.createdAt).toBe(1710000000000);
  });

  test("uses lastMessageAt falling back to updatedAt", () => {
    const result = toConversation(
      makeRaw({ id: "c", lastMessageAt: 1710000000000, updatedAt: 1 }),
    );
    expect(result.lastMessageAt).toBe(1710000000000);

    const fallback = toConversation(
      makeRaw({ id: "c", lastMessageAt: null, updatedAt: 1710000060000 }),
    );
    expect(fallback.lastMessageAt).toBe(1710000060000);
  });

  test("flattens assistantAttention fields", () => {
    const result = toConversation(
      makeRaw({
        id: "c",
        assistantAttention: {
          hasUnseenLatestAssistantMessage: true,
          latestAssistantMessageAt: 1710000000000,
          lastSeenAssistantMessageAt: 1709999000000,
        },
      }),
    );
    expect(result.hasUnseenLatestAssistantMessage).toBe(true);
    expect(result.latestAssistantMessageAt).toBe(1710000000000);
    expect(result.lastSeenAssistantMessageAt).toBe(1709999000000);
  });

  test("passes through scalar fields", () => {
    const result = toConversation(
      makeRaw({
        id: "c",
        archivedAt: 1710000000000,
        groupId: "group-1",
        source: "telegram",
        isPinned: true,
        conversationType: "background",
        scheduleJobId: "job-1",
        displayOrder: 3,
      }),
    );
    expect(result.archivedAt).toBe(1710000000000);
    expect(result.groupId).toBe("group-1");
    expect(result.source).toBe("telegram");
    expect(result.isPinned).toBe(true);
    expect(result.conversationType).toBe("background");
    expect(result.scheduleJobId).toBe("job-1");
    expect(result.displayOrder).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// toConversation — originChannel coalescing
// ---------------------------------------------------------------------------

describe("toConversation — originChannel plumbing", () => {
  test("leaves originChannel undefined when neither field is present", () => {
    const result = toConversation(makeRaw({ id: "c" }));
    expect(result.originChannel).toBeUndefined();
  });

  test("reads originChannel from conversationOriginChannel as a fallback", () => {
    const result = toConversation(
      makeRaw({ id: "c", conversationOriginChannel: "slack" }),
    );
    expect(result.originChannel).toBe("slack");
  });

  test("prefers channelBinding.sourceChannel over conversationOriginChannel", () => {
    const result = toConversation(
      makeRaw({
        id: "c",
        channelBinding: {
          sourceChannel: "telegram",
          externalChatId: "ext-1",
          externalUserId: "",
          displayName: "",
          username: "",
        },
        conversationOriginChannel: "slack",
      }),
    );
    expect(result.originChannel).toBe("telegram");
  });

  test("preserves a notification:* sourceChannel as a literal pass-through", () => {
    const result = toConversation(
      makeRaw({
        id: "c",
        channelBinding: {
          sourceChannel: "notification:reminder",
          externalChatId: "ext-1",
          externalUserId: "",
          displayName: "",
          username: "",
        },
      }),
    );
    expect(result.originChannel).toBe("notification:reminder");
  });
});

// ---------------------------------------------------------------------------
// toConversation — displayOrder
// ---------------------------------------------------------------------------

describe("toConversation — displayOrder", () => {
  test("captures numeric displayOrder for drag-reordered conversations", () => {
    const result = toConversation(
      makeRaw({ id: "c", isPinned: true, displayOrder: 3 }),
    );
    expect(result.displayOrder).toBe(3);
  });

  test("leaves displayOrder undefined when the field is absent", () => {
    const result = toConversation(makeRaw({ id: "c" }));
    expect(result.displayOrder).toBeUndefined();
  });

  test("treats non-finite displayOrder as missing", () => {
    expect(
      toConversation(makeRaw({ id: "c", displayOrder: Number.NaN }))
        .displayOrder,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toConversation — channel binding mapping
// ---------------------------------------------------------------------------

describe("toConversation — Slack channel binding", () => {
  test("preserves Slack channel binding with name and link", () => {
    const result = toConversation(
      makeRaw({
        id: "conv-123",
        channelBinding: {
          sourceChannel: "slack",
          externalChatId: "C0123ABCDEF",
          externalThreadId: "1710000000.000100",
          externalChatName: "product",
          externalUserId: "",
          displayName: "",
          username: "",
          slackChannel: {
            channelId: "C0123ABCDEF",
            name: "product",
            link: {
              webUrl:
                "https://example.slack.com/archives/C0123ABCDEF",
            },
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
      }),
    );

    expect(result.originChannel).toBe("slack");
    expect(result.channelBinding).toEqual({
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000100",
      externalChatName: "product",
      externalUserId: "",
      displayName: "",
      username: "",
      slackChannel: {
        channelId: "C0123ABCDEF",
        name: "product",
        link: {
          webUrl: "https://example.slack.com/archives/C0123ABCDEF",
        },
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

  test("falls back to conversationOriginChannel when channelBinding is absent", () => {
    const result = toConversation(
      makeRaw({ id: "conv-123", conversationOriginChannel: "slack" }),
    );

    expect(result.originChannel).toBe("slack");
    expect(result.channelBinding).toBeUndefined();
  });

  test("preserves Slack actor identity fields on channel bindings", () => {
    const result = toConversation(
      makeRaw({
        id: "conv-dm",
        channelBinding: {
          sourceChannel: "slack",
          externalChatId: "D0123ABCDEF",
          externalUserId: "U0123ABCDEF",
          displayName: "Example User",
          username: "example_user",
        },
      }),
    );

    expect(result.channelBinding).toMatchObject({
      sourceChannel: "slack",
      externalChatId: "D0123ABCDEF",
      externalUserId: "U0123ABCDEF",
      displayName: "Example User",
      username: "example_user",
    });
  });
});
