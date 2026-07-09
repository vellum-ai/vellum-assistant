import { afterEach, describe, expect, mock, test } from "bun:test";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  hasAnyActiveConversation,
  listBackgroundConversations,
  listConversations,
} from "@/utils/conversation-list-fetchers";
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

// ---------------------------------------------------------------------------
// listConversations — pagination
// ---------------------------------------------------------------------------

describe("listConversations — pagination", () => {
  const originalGet = daemonClient.get;
  type GetOptions = {
    query?: Record<string, unknown>;
  };

  type Page = {
    conversations: Array<{
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      lastMessageAt: number;
      conversationType: "standard" | "background" | "scheduled";
      source: string;
      groupId: string;
    }>;
    hasMore?: boolean;
  };

  function makeConversationRow(id: string): Page["conversations"][number] {
    return {
      id,
      title: "",
      createdAt: 0,
      updatedAt: 0,
      lastMessageAt: 0,
      conversationType: "standard",
      source: "vellum",
      groupId: "",
    };
  }

  function setupPagedResponses(pages: {
    foreground: Page[];
    background?: Page[];
  }): {
    calls: Array<{ url: unknown; query: Record<string, unknown> | undefined }>;
  } {
    const calls: Array<{
      url: unknown;
      query: Record<string, unknown> | undefined;
    }> = [];
    const foregroundQueue = [...pages.foreground];
    const backgroundQueue = [
      ...(pages.background ?? [{ conversations: [] }]),
    ];
    daemonClient.get = mock(
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
    ) as typeof daemonClient.get;
    return { calls };
  }

  afterEach(() => {
    daemonClient.get = originalGet;
  });

  test("loops over pages until hasMore is false (>50 conversations preserved)", async () => {
    const page1Items = Array.from({ length: 50 }, (_, i) =>
      makeConversationRow(`foreground-${i}`),
    );
    const page2Items = Array.from({ length: 30 }, (_, i) =>
      makeConversationRow(`foreground-${50 + i}`),
    );
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
    // Foreground only — background is a separate lazily-enabled query and is
    // never fetched here.
    expect(calls).toHaveLength(2);
    const foregroundCalls = calls.filter(
      (c) => c.query?.conversationType === undefined,
    );
    expect(foregroundCalls).toHaveLength(2);
    expect(foregroundCalls[0]?.query).toMatchObject({ limit: 50, offset: 0 });
    expect(foregroundCalls[1]?.query).toMatchObject({ limit: 50, offset: 50 });
    const backgroundCalls = calls.filter(
      (c) => c.query?.conversationType === "background",
    );
    expect(backgroundCalls).toHaveLength(0);
  });

  test("stops on the first page when hasMore is false or absent", async () => {
    const { calls } = setupPagedResponses({
      foreground: [
        { conversations: [makeConversationRow("only-one")] },
      ],
    });

    const result = await listConversations("assistant-1");

    expect(result).toHaveLength(1);
    // Foreground only — a single page, no background fetch.
    expect(calls).toHaveLength(1);
  });

  test("does not loop forever on hasMore=true with empty page", async () => {
    const { calls } = setupPagedResponses({
      foreground: [
        { conversations: [makeConversationRow("a")], hasMore: true },
        { conversations: [], hasMore: true },
      ],
    });

    const result = await listConversations("assistant-1");

    expect(result).toHaveLength(1);
    expect(calls).toHaveLength(2); // 2 foreground pages, no background
  });
});

// ---------------------------------------------------------------------------
// listBackgroundConversations — pagination
// ---------------------------------------------------------------------------

describe("listBackgroundConversations — pagination", () => {
  const originalGet = daemonClient.get;
  type GetOptions = {
    query?: Record<string, unknown>;
  };

  type Page = {
    conversations: Array<{
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      lastMessageAt: number;
      conversationType: "standard" | "background" | "scheduled";
      source: string;
      groupId: string;
    }>;
    hasMore?: boolean;
  };

  function makeBackgroundRow(id: string): Page["conversations"][number] {
    return {
      id,
      title: "",
      createdAt: 0,
      updatedAt: 0,
      lastMessageAt: 0,
      conversationType: "background",
      source: "vellum",
      groupId: "",
    };
  }

  afterEach(() => {
    daemonClient.get = originalGet;
  });

  test("fetches only the background bucket and paginates it", async () => {
    /**
     * The lazily-enabled background query pages through the background bucket
     * and never touches the foreground list.
     */

    // GIVEN two pages of background conversations
    const calls: Array<{ query: Record<string, unknown> | undefined }> = [];
    daemonClient.get = mock(async (options: GetOptions) => {
      calls.push({ query: options.query });
      const offset = Number(options.query?.offset ?? 0);
      const data =
        offset === 0
          ? { conversations: [makeBackgroundRow("bg-0")], hasMore: true }
          : { conversations: [makeBackgroundRow("bg-1")], hasMore: false };
      return {
        data,
        error: null,
        response: new Response(null, { status: 200 }),
      };
    }) as typeof daemonClient.get;

    // WHEN we list background conversations
    const result = await listBackgroundConversations("assistant-1");

    // THEN both pages are returned
    expect(result.map((c) => c.conversationId)).toEqual(["bg-0", "bg-1"]);
    // AND every request targets the background bucket
    expect(calls).toHaveLength(2);
    expect(
      calls.every((c) => c.query?.conversationType === "background"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAnyActiveConversation — single-page existence probe
// ---------------------------------------------------------------------------

describe("hasAnyActiveConversation", () => {
  const originalGet = daemonClient.get;

  afterEach(() => {
    daemonClient.get = originalGet;
  });

  function setupSinglePage(conversationIds: string[]): {
    calls: Array<{ query: Record<string, unknown> | undefined }>;
  } {
    const calls: Array<{ query: Record<string, unknown> | undefined }> = [];
    daemonClient.get = mock(
      async (options: { query?: Record<string, unknown> }) => {
        calls.push({ query: options.query });
        return {
          data: {
            conversations: conversationIds.map((id) => ({
              id,
              title: "",
              createdAt: 0,
              updatedAt: 0,
              lastMessageAt: 0,
              conversationType: "standard",
              source: "vellum",
              groupId: "",
            })),
            // Existence needs one page — hasMore must never trigger a walk.
            hasMore: true,
          },
          error: null,
          response: new Response(null, { status: 200 }),
        };
      },
    ) as typeof daemonClient.get;
    return { calls };
  }

  test("true when the first page has any conversation, fetching exactly one page", async () => {
    const { calls } = setupSinglePage(["conv-1"]);

    await expect(hasAnyActiveConversation("assistant-1")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("false when the assistant has no active conversations", async () => {
    setupSinglePage([]);

    await expect(hasAnyActiveConversation("assistant-1")).resolves.toBe(false);
  });

  test("throws on a failed fetch (callers own the fail-open policy)", async () => {
    daemonClient.get = mock(async () => ({
      data: null,
      error: { message: "boom" },
      response: new Response(null, { status: 500 }),
    })) as typeof daemonClient.get;

    await expect(hasAnyActiveConversation("assistant-1")).rejects.toThrow();
  });
});
