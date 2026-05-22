import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../../../../oauth/connection.js";
import { credentialKey } from "../../../../security/credential-key.js";

const BOT_TOKEN = "xoxb-BOT";

const getSecureKeyAsyncMock = mock(
  async (_key: string): Promise<string | null> => null,
);
mock.module("../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

mock.module("../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (): Promise<OAuthConnection> => {
    throw new Error("OAuth fallback was not expected");
  },
}));
mock.module("../../../../oauth/oauth-store.js", () => ({
  isProviderConnected: async () => false,
}));

const findContactChannelMock = mock((): unknown => undefined);
const upsertContactChannelMock = mock(() => {});
mock.module("../../../../contacts/contact-store.js", () => ({
  findContactChannel: findContactChannelMock,
}));
mock.module("../../../../contacts/contacts-write.js", () => ({
  upsertContactChannel: upsertContactChannelMock,
}));

import {
  __resetSlackUserInfoCacheForTests,
  slackProvider,
} from "../adapter.js";

const originalFetch = globalThis.fetch;
let userInfoCalls: string[] = [];

function installFetchStub() {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers ?? {});
    expect(headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);

    return new Response(JSON.stringify(fakeSlackResponse(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function fakeSlackResponse(url: string): Record<string, unknown> {
  const parsed = new URL(url);
  const method = parsed.pathname.split("/").at(-1);

  if (method === "conversations.history") {
    if (parsed.searchParams.get("channel") === "C_USERINFO_FAIL") {
      return {
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            ts: "1700000006.000700",
            user: "UMISSING",
            text: "Fallback sender message",
          },
        ],
      };
    }

    if (parsed.searchParams.get("channel") === "C_USERINFO_RETRY") {
      return {
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            ts: "1700000007.000800",
            user: "URETRY",
            text: "Retry sender message",
          },
        ],
      };
    }

    if (parsed.searchParams.get("channel") === "C_TIMEZONE_CACHE") {
      return {
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            ts: "1700000004.000500",
            user: "USENDER",
            text: "First timezone-bearing message",
          },
          {
            type: "message",
            ts: "1700000005.000600",
            user: "USENDER",
            text: "Second timezone-bearing message",
          },
        ],
      };
    }

    if (parsed.searchParams.get("channel") === "C_BOT_HISTORY") {
      return {
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            subtype: "bot_message",
            ts: "1700000003.000400",
            bot_id: "B_ASSISTANT",
            text: "Bot-authored history",
          },
        ],
      };
    }

    return {
      ok: true,
      has_more: false,
      messages: [
        {
          type: "message",
          ts: "1700000000.000100",
          user: "USENDER",
          text: "History for <@ULEO> and <@UMISSING>",
          thread_ts: "1700000000.000100",
          reply_count: 2,
          reactions: [{ name: "eyes", count: 1, users: ["ULEO"] }],
        },
      ],
    };
  }

  if (method === "conversations.replies") {
    return {
      ok: true,
      has_more: false,
      messages: [
        {
          type: "message",
          ts: "1700000001.000200",
          user: "UTHREAD",
          text: "Thread follow-up for <@ULEO>",
          thread_ts: "1700000000.000100",
        },
      ],
    };
  }

  if (method === "search.messages") {
    return {
      ok: true,
      messages: {
        total: 1,
        matches: [
          {
            iid: "search-1",
            ts: "1700000002.000300",
            text: "Search result for <@ULEO> and <@UMISSING>",
            user: "USENDER",
            username: "sender",
            channel: { id: "C_HISTORY", name: "history" },
            permalink:
              "https://example.slack.com/archives/C_HISTORY/p1700000002000300",
            thread_ts: "1700000000.000100",
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    };
  }

  if (method === "users.info") {
    const userId = parsed.searchParams.get("user") ?? "";
    userInfoCalls.push(userId);
    return fakeUserInfoResponse(userId);
  }

  return { ok: true };
}

function fakeUserInfoResponse(userId: string): Record<string, unknown> {
  if (userId === "ULEO") {
    return {
      ok: true,
      user: {
        id: "ULEO",
        name: "leo",
        profile: { display_name: "Leo" },
      },
    };
  }

  if (userId === "USENDER") {
    return {
      ok: true,
      user: {
        id: "USENDER",
        name: "sender",
        tz: "America/New_York",
        tz_label: "Eastern Time",
        tz_offset: -18000,
        profile: { display_name: "Sender" },
      },
    };
  }

  if (userId === "UTHREAD") {
    return {
      ok: true,
      user: {
        id: "UTHREAD",
        name: "thread_sender",
        profile: { display_name: "Thread Sender" },
      },
    };
  }

  if (userId === "URETRY") {
    const retryCalls = userInfoCalls.filter((call) => call === userId).length;
    if (retryCalls === 1) {
      return { ok: false, error: "temporarily_unavailable" };
    }
    return {
      ok: true,
      user: {
        id: "URETRY",
        name: "retry_sender",
        tz: "America/Chicago",
        tz_label: "Central Time",
        tz_offset: -21600,
        profile: { display_name: "Retry Sender" },
      },
    };
  }

  return { ok: false, error: "user_not_found" };
}

function makeOAuthConnection(
  id: string,
  accountInfo: string,
  displayName: string,
  timezone: string,
  timezoneLabel: string,
  timezoneOffsetSeconds: number,
): OAuthConnection {
  return {
    id,
    provider: "slack",
    accountInfo,
    request: async (req) => {
      if (req.path === "/conversations.history") {
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            has_more: false,
            messages: [
              {
                type: "message",
                ts: "1700000008.000900",
                user: "USAME",
                text: "Account scoped sender",
              },
            ],
          },
        };
      }
      if (req.path === "/users.info") {
        const userId = req.query?.user;
        userInfoCalls.push(`${id}:${userId}`);
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            user: {
              id: "USAME",
              name: displayName.toLowerCase().replaceAll(" ", "_"),
              tz: timezone,
              tz_label: timezoneLabel,
              tz_offset: timezoneOffsetSeconds,
              profile: { display_name: displayName },
            },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        body: { ok: true },
      };
    },
    withToken: async <T>(_fn: (token: string) => Promise<T>): Promise<T> => {
      throw new Error("withToken was not expected");
    },
  };
}

describe("Slack adapter mention rendering", () => {
  beforeEach(async () => {
    __resetSlackUserInfoCacheForTests();
    userInfoCalls = [];
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      return null;
    });
    findContactChannelMock.mockClear();
    upsertContactChannelMock.mockClear();
    installFetchStub();
    await slackProvider.resolveConnection!();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("getHistory renders Slack user mentions for model-facing text without changing sender identity", async () => {
    const messages = await slackProvider.getHistory(undefined, "C_HISTORY");

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("History for @Leo and @unknown-user");
    expect(messages[0].sender).toEqual({ id: "USENDER", name: "Sender" });
    expect(messages[0].threadId).toBe("1700000000.000100");
    expect(messages[0].replyCount).toBe(2);
    expect(messages[0].reactions).toEqual([{ name: "eyes", count: 1 }]);
  });

  test("getHistory preserves bot ids for bot-authored Slack messages", async () => {
    const messages = await slackProvider.getHistory(undefined, "C_BOT_HISTORY");

    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toEqual({ id: "B_ASSISTANT", name: "unknown" });
    expect(messages[0].metadata).toEqual({
      isBot: true,
      slackBotId: "B_ASSISTANT",
    });
  });

  test("getHistory caches Slack user info and maps timezone metadata", async () => {
    const messages = await slackProvider.getHistory(
      undefined,
      "C_TIMEZONE_CACHE",
    );

    expect(messages).toHaveLength(2);
    expect(userInfoCalls.filter((userId) => userId === "USENDER")).toHaveLength(
      1,
    );
    expect(messages.map((message) => message.sender)).toEqual([
      { id: "USENDER", name: "Sender" },
      { id: "USENDER", name: "Sender" },
    ]);
    expect(messages.map((message) => message.metadata)).toEqual([
      {
        actorTimezone: "America/New_York",
        actorTimezoneLabel: "Eastern Time",
        actorTimezoneOffsetSeconds: -18000,
      },
      {
        actorTimezone: "America/New_York",
        actorTimezoneLabel: "Eastern Time",
        actorTimezoneOffsetSeconds: -18000,
      },
    ]);
  });

  test("getHistory prefers contact display names while still fetching Slack timezone facts", async () => {
    findContactChannelMock.mockImplementationOnce(() => ({
      contact: { displayName: "Saved Sender" },
    }));

    const messages = await slackProvider.getHistory(
      undefined,
      "C_TIMEZONE_CACHE",
    );

    expect(userInfoCalls.filter((userId) => userId === "USENDER")).toHaveLength(
      1,
    );
    expect(messages[0].sender).toEqual({
      id: "USENDER",
      name: "Saved Sender",
    });
    expect(messages[0].metadata).toEqual({
      actorTimezone: "America/New_York",
      actorTimezoneLabel: "Eastern Time",
      actorTimezoneOffsetSeconds: -18000,
    });
  });

  test("getHistory caches fallback user info for permanent users.info failures", async () => {
    const firstMessages = await slackProvider.getHistory(
      undefined,
      "C_USERINFO_FAIL",
    );
    const secondMessages = await slackProvider.getHistory(
      undefined,
      "C_USERINFO_FAIL",
    );

    expect(firstMessages).toHaveLength(1);
    expect(secondMessages).toHaveLength(1);
    expect(
      userInfoCalls.filter((userId) => userId === "UMISSING"),
    ).toHaveLength(1);
    expect(firstMessages[0].sender).toEqual({
      id: "UMISSING",
      name: "UMISSING",
    });
    expect(secondMessages[0].sender).toEqual({
      id: "UMISSING",
      name: "UMISSING",
    });
    expect(firstMessages[0].metadata).toBeUndefined();
    expect(secondMessages[0].metadata).toBeUndefined();
  });

  test("getHistory does not cache fallback user info after transient users.info failures", async () => {
    const firstMessages = await slackProvider.getHistory(
      undefined,
      "C_USERINFO_RETRY",
    );
    const secondMessages = await slackProvider.getHistory(
      undefined,
      "C_USERINFO_RETRY",
    );

    expect(userInfoCalls.filter((userId) => userId === "URETRY")).toHaveLength(
      2,
    );
    expect(firstMessages[0].sender).toEqual({
      id: "URETRY",
      name: "URETRY",
    });
    expect(firstMessages[0].metadata).toBeUndefined();
    expect(secondMessages[0].sender).toEqual({
      id: "URETRY",
      name: "Retry Sender",
    });
    expect(secondMessages[0].metadata).toEqual({
      actorTimezone: "America/Chicago",
      actorTimezoneLabel: "Central Time",
      actorTimezoneOffsetSeconds: -21600,
    });
  });

  test("getHistory scopes Slack user info cache by OAuth connection", async () => {
    const workspaceA = makeOAuthConnection(
      "conn-workspace-a",
      "workspace-a",
      "Workspace A Sender",
      "America/Los_Angeles",
      "Pacific Time",
      -28800,
    );
    const workspaceB = makeOAuthConnection(
      "conn-workspace-b",
      "workspace-b",
      "Workspace B Sender",
      "Europe/London",
      "Greenwich Mean Time",
      0,
    );

    const messagesA = await slackProvider.getHistory(
      workspaceA,
      "C_ACCOUNT_SCOPE",
    );
    const messagesB = await slackProvider.getHistory(
      workspaceB,
      "C_ACCOUNT_SCOPE",
    );

    expect(userInfoCalls).toContain("conn-workspace-a:USAME");
    expect(userInfoCalls).toContain("conn-workspace-b:USAME");
    expect(messagesA[0].sender).toEqual({
      id: "USAME",
      name: "Workspace A Sender",
    });
    expect(messagesA[0].metadata).toEqual({
      actorTimezone: "America/Los_Angeles",
      actorTimezoneLabel: "Pacific Time",
      actorTimezoneOffsetSeconds: -28800,
    });
    expect(messagesB[0].sender).toEqual({
      id: "USAME",
      name: "Workspace B Sender",
    });
    expect(messagesB[0].metadata).toEqual({
      actorTimezone: "Europe/London",
      actorTimezoneLabel: "Greenwich Mean Time",
      actorTimezoneOffsetSeconds: 0,
    });
  });

  test("getThreadReplies renders Slack user mentions for model-facing text without changing sender identity", async () => {
    const messages = await slackProvider.getThreadReplies!(
      undefined,
      "C_HISTORY",
      "1700000000.000100",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Thread follow-up for @Leo");
    expect(messages[0].sender).toEqual({
      id: "UTHREAD",
      name: "Thread Sender",
    });
    expect(messages[0].threadId).toBe("1700000000.000100");
  });

  test("search renders Slack user mentions for model-facing text", async () => {
    const result = await slackProvider.search!(undefined, "from:sender");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe(
      "Search result for @Leo and @unknown-user",
    );
    expect(result.messages[0].sender).toEqual({
      id: "USENDER",
      name: "sender",
    });
    expect(result.messages[0].metadata).toEqual({
      permalink:
        "https://example.slack.com/archives/C_HISTORY/p1700000002000300",
      channelName: "history",
    });
  });
});
