/**
 * Guard test that verifies the Slack adapter routes reads and writes through
 * the correct cached auth.
 *
 * Covers the bot-token-only case (reads and writes both use the bot token),
 * the dual-token case (bot + user): reads MUST use the user token while
 * content-creating writes (postMessage) MUST stay on the bot token so posts
 * come from the bot identity, and the runtime fallback when a stored user
 * token is rejected with an auth error.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../../../../oauth/connection.js";
import { credentialKey } from "../../../../security/credential-key.js";

// ── Module mocks ────────────────────────────────────────────────────────────

const getSecureKeyAsyncMock = mock(
  async (_key: string): Promise<string | null> => null,
);
mock.module("../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

// OAuth helpers are exercised only when no bot_token is cached. The adapter
// imports them at module load — route them through a stub that signals any
// OAuth fallback with a distinctive error so tests can assert on it.
const OAUTH_FALLBACK_SENTINEL = "OAUTH_FALLBACK_NOT_STUBBED";
mock.module("../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (): Promise<OAuthConnection> => {
    throw new Error(OAUTH_FALLBACK_SENTINEL);
  },
}));
mock.module("../../../../oauth/oauth-store.js", () => ({
  isProviderConnected: async () => false,
}));

// Stub contact DB access so the adapter doesn't touch SQLite during the test.
mock.module("../../../../contacts/contact-store.js", () => ({
  findContactChannel: () => undefined,
}));
mock.module("../../../../contacts/contacts-write.js", () => ({
  upsertContactChannel: () => {},
}));

import { slackProvider } from "../adapter.js";

// ── fetch capture ───────────────────────────────────────────────────────────

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string | null;
};

const captured: CapturedRequest[] = [];
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
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    captured.push({
      url,
      method,
      authorization: headers.get("authorization"),
    });

    // Craft a minimal OK Slack API envelope per endpoint so the adapter's
    // post-call mapping doesn't throw.
    const body = fakeSlackResponse(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function fakeSlackResponse(url: string): Record<string, unknown> {
  if (url.includes("/conversations.list")) {
    return { ok: true, channels: [], response_metadata: { next_cursor: "" } };
  }
  if (url.includes("/conversations.history")) {
    return { ok: true, messages: [], has_more: false };
  }
  if (url.includes("/conversations.mark")) {
    return { ok: true };
  }
  if (url.includes("/chat.postMessage")) {
    return { ok: true, ts: "1700000000.000100", channel: "C123" };
  }
  // Default envelope for any other method the adapter might call.
  return { ok: true };
}

// ── Test setup ──────────────────────────────────────────────────────────────

const BOT_TOKEN = "xoxb-BOT";
const USER_TOKEN = "xoxp-USER";

describe("Slack adapter token routing", () => {
  beforeEach(() => {
    captured.length = 0;
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      return null;
    });
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("bot-token only: reads and writes both authenticate with the bot token (regression guard for pre-user-token behavior)", async () => {
    // With only a bot token stored, reads must fall back to the bot token
    // so the adapter keeps working for installs that haven't re-consented
    // the user scope. Writes stay on the bot token always.
    const resolved = await slackProvider.resolveConnection!();
    expect(resolved).toBeUndefined();

    // Read path: listConversations → /conversations.list must use bot token.
    await slackProvider.listConversations(undefined);
    const readCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(readCall).toBeDefined();
    expect(readCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);

    // Write path: sendMessage → /chat.postMessage must also use bot token.
    await slackProvider.sendMessage(undefined, "C123", "hello");
    const writeCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(writeCall).toBeDefined();
    expect(writeCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("bot + user tokens: reads authenticate with the user token, writes with the bot token", async () => {
    // With both tokens stored, reads MUST flip to the user token so the
    // adapter can see channels the user is in but the bot isn't. Writes
    // MUST stay on the bot token so posts come from the bot identity.
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    const resolved = await slackProvider.resolveConnection!();
    expect(resolved).toBeUndefined();

    // Reads: listConversations → user token.
    await slackProvider.listConversations(undefined);
    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);

    // Reads: getHistory → user token.
    await slackProvider.getHistory(undefined, "C123");
    const historyCall = captured.find((c) =>
      c.url.includes("/conversations.history"),
    );
    expect(historyCall).toBeDefined();
    expect(historyCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);

    // Writes: sendMessage → bot token.
    await slackProvider.sendMessage(undefined, "C123", "hello");
    const sendCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);

    // markRead → user token. conversations.mark sets the read cursor for
    // the authenticated identity, so it must use the same token whose unread
    // counts the adapter exposes.
    await slackProvider.markRead!(undefined, "C123", "1700000000.000100");
    const markCall = captured.find((c) =>
      c.url.includes("/conversations.mark"),
    );
    expect(markCall).toBeDefined();
    expect(markCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  test("user token rejected: read calls fall back to bot token and stay on it", async () => {
    // If the cached user token is revoked/expired, the next read returns
    // invalid_auth (HTTP 200 with ok:false). The adapter must retry the call
    // with the bot token and reset the read cache so subsequent reads in the
    // same session don't re-hit the failure path.
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    // Replace the default fetch stub: first user-token call to history fails
    // with invalid_auth; everything else succeeds.
    let userTokenHistoryCalls = 0;
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
      const auth = headers.get("authorization");
      captured.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        authorization: auth,
      });
      if (
        url.includes("/conversations.history") &&
        auth === `Bearer ${USER_TOKEN}`
      ) {
        userTokenHistoryCalls += 1;
        return new Response(
          JSON.stringify({ ok: false, error: "invalid_auth" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(fakeSlackResponse(url)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const resolved = await slackProvider.resolveConnection!();
    expect(resolved).toBeUndefined();

    // First read: tries user token, fails, retries with bot token.
    await slackProvider.getHistory(undefined, "C123");
    expect(userTokenHistoryCalls).toBe(1);
    const historyCalls = captured.filter((c) =>
      c.url.includes("/conversations.history"),
    );
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(historyCalls[1].authorization).toBe(`Bearer ${BOT_TOKEN}`);

    // Subsequent read: cache reset, only bot token is used (no retry needed).
    captured.length = 0;
    await slackProvider.getHistory(undefined, "C456");
    const next = captured.filter((c) =>
      c.url.includes("/conversations.history"),
    );
    expect(next).toHaveLength(1);
    expect(next[0].authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("user-token only (no bot token): falls through to the OAuth path", async () => {
    // Edge case: if only a user token is stored with no bot token, we do NOT
    // have Socket Mode credentials, so resolveConnection() falls through to
    // the legacy OAuth path. The mocked resolveOAuthConnection throws, which
    // documents current behavior — user-token-only without an OAuth
    // connection is not a supported install configuration.
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    await expect(slackProvider.resolveConnection!()).rejects.toThrow(
      OAUTH_FALLBACK_SENTINEL,
    );
  });
});
