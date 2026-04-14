/**
 * Guard test that verifies the Slack adapter routes reads and writes through
 * the correct cached auth.
 *
 * PR 3 introduced the read/write auth split and locked in behavior for the
 * bot-token-only case. PR 5 extended this file to cover the dual-token case
 * (bot + user): reads MUST use the user token while writes MUST stay on the
 * bot token so posts come from the bot identity.
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

    // Writes: markRead → bot token.
    await slackProvider.markRead!(undefined, "C123", "1700000000.000100");
    const markCall = captured.find((c) =>
      c.url.includes("/conversations.mark"),
    );
    expect(markCall).toBeDefined();
    expect(markCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
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
