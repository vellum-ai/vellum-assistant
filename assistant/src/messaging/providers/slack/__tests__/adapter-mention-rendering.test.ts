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

const findContactChannelMock = mock(() => undefined);
const upsertContactChannelMock = mock(() => {});
mock.module("../../../../contacts/contact-store.js", () => ({
  findContactChannel: findContactChannelMock,
}));
mock.module("../../../../contacts/contacts-write.js", () => ({
  upsertContactChannel: upsertContactChannelMock,
}));

import { slackProvider } from "../adapter.js";

const originalFetch = globalThis.fetch;

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
    return fakeUserInfoResponse(parsed.searchParams.get("user") ?? "");
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

  return { ok: false, error: "user_not_found" };
}

describe("Slack adapter mention rendering", () => {
  beforeEach(async () => {
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
