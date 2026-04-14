/**
 * Guard test that verifies the Slack adapter routes reads and writes through
 * the correct cached auth. Today (PR 3 of the slack-user-token-triage plan)
 * both caches hold the bot token — this test locks in that behavior so the
 * follow-up PR that introduces user_token for reads cannot silently regress
 * write routing.
 *
 * PR 5 will extend this file with a two-token case (bot + user) asserting
 * reads switch to the user token while writes stay on the bot token.
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

// OAuth helpers aren't exercised when a bot token is present, but the adapter
// imports them at module load — provide no-op stubs so imports resolve.
mock.module("../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (): Promise<OAuthConnection> => {
    throw new Error(
      "resolveOAuthConnection should not be called when bot_token is present",
    );
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
  if (url.includes("/chat.postMessage")) {
    return { ok: true, ts: "1700000000.000100", channel: "C123" };
  }
  // Default envelope for any other method the adapter might call.
  return { ok: true };
}

// ── Test setup ──────────────────────────────────────────────────────────────

const BOT_TOKEN = "xoxb-BOT";

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

  test("bot-token only: reads and writes both authenticate with the bot token (behavior-preserving refactor)", async () => {
    // Populate both caches via resolveConnection(). With only a bot token
    // configured today, read auth and write auth both resolve to it.
    const resolved = await slackProvider.resolveConnection!();
    expect(resolved).toBeUndefined();

    // Read path: listConversations → /conversations.list must use bot token.
    await slackProvider.listConversations(undefined);
    const readCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(readCall).toBeDefined();
    expect(readCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);

    // Write path: sendMessage → /chat.postMessage must also use bot token
    // (same token until PR 5 introduces a user_token for reads).
    await slackProvider.sendMessage(undefined, "C123", "hello");
    const writeCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(writeCall).toBeDefined();
    expect(writeCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });
});
