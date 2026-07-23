/**
 * Unit tests for Slack route handler token routing.
 *
 * Verifies which Slack identity each route acts as (see slack/auth.ts):
 * - Channel enumeration (`channels.ts`, GET /v1/slack/channels) prefers the
 *   user_token when present so the picker surfaces channels the user is in but
 *   the bot isn't.
 * - Channel sharing (`share.ts`, POST /v1/slack/share) is a human-initiated
 *   action: it posts as the user (user_token) when one is present so the
 *   message reads as the person who shared, falling back to the bot_token when
 *   no user token is stored or it can't post (401, or missing chat:write).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../../../../../security/credential-key.js";
import { ServiceUnavailableError } from "../../../errors.js";

// ── Module mocks ────────────────────────────────────────────────────────────

const getSecureKeyAsyncMock = mock(
  async (_key: string): Promise<string | null> => null,
);
mock.module("../../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

mock.module("../../../../../oauth/oauth-store.js", () => ({
  getConnectionByProvider: () => undefined,
}));

// These handlers resolve auth through messaging/providers/slack/auth.ts, which
// imports the OAuth connection resolver. Socket Mode (bot token) never reaches
// it, but the module must be stubbed so the import graph loads under the
// partial secure-keys mock above.
mock.module("../../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => {
    throw new Error("No OAuth connection (Socket Mode test)");
  },
}));

const FAKE_APP = { id: "app-1", name: "Test App", description: "desc" };
mock.module("../../../../../apps/app-store.js", () => ({
  getApp: (id: string) => (id === FAKE_APP.id ? FAKE_APP : undefined),
}));

const { handleListSlackChannels } = await import("../channels.js");
const { handleShareToSlackChannel } = await import("../share.js");

// ── fetch capture ───────────────────────────────────────────────────────────

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string | null;
};

const captured: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

// When set, chat.postMessage requests carrying this exact Authorization header
// respond with `missing_scope`, so a share as the user falls through to the
// bot token on the wire.
let failPostMessageForAuth: string | null = null;

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
    const authorization = headers.get("authorization");
    captured.push({ url, method, authorization });

    const body =
      url.includes("/chat.postMessage") &&
      failPostMessageForAuth !== null &&
      authorization === failPostMessageForAuth
        ? { ok: false, error: "missing_scope" }
        : fakeSlackResponse(url);
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
  return { ok: true };
}

// ── Test fixtures ───────────────────────────────────────────────────────────

const BOT_TOKEN = "xoxb-test-bot-token";
const USER_TOKEN = "xoxp-test-user-token";

describe("Slack share route token routing", () => {
  beforeEach(() => {
    captured.length = 0;
    failPostMessageForAuth = null;
    getSecureKeyAsyncMock.mockReset();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /v1/slack/channels: bot-only install reads with bot token", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      return null;
    });

    const result = (await handleListSlackChannels()) as {
      channels: unknown[];
    };
    expect(result).toHaveProperty("channels");

    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("GET /v1/slack/channels: bot + user tokens prefer user_token for reads", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      if (key === credentialKey("slack_channel", "user_token")) {
        return USER_TOKEN;
      }
      return null;
    });

    const result = (await handleListSlackChannels()) as {
      channels: unknown[];
    };
    expect(result).toHaveProperty("channels");

    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  test("POST /v1/slack/share: bot + user tokens post as the user", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      if (key === credentialKey("slack_channel", "user_token")) {
        return USER_TOKEN;
      }
      return null;
    });

    const result = (await handleShareToSlackChannel({
      body: { appId: FAKE_APP.id, channelId: "C123" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    // Sharing is a human action — it posts as the user, not the bot.
    const postCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall).toBeDefined();
    expect(postCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  test("POST /v1/slack/share: falls back to the bot token when the user token can't post", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      if (key === credentialKey("slack_channel", "user_token")) {
        return USER_TOKEN;
      }
      return null;
    });
    // The user token lacks chat:write; the bot token can post.
    failPostMessageForAuth = `Bearer ${USER_TOKEN}`;

    const result = (await handleShareToSlackChannel({
      body: { appId: FAKE_APP.id, channelId: "C123" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    // It tries the user token first, then retries on the wire as the bot.
    const postAuths = captured
      .filter((c) => c.url.includes("/chat.postMessage"))
      .map((c) => c.authorization);
    expect(postAuths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${BOT_TOKEN}`]);
  });

  test("no tokens configured: both handlers throw ServiceUnavailableError", async () => {
    getSecureKeyAsyncMock.mockImplementation(async () => null);

    expect(handleListSlackChannels()).rejects.toThrow(ServiceUnavailableError);

    expect(
      handleShareToSlackChannel({
        body: { appId: FAKE_APP.id, channelId: "C123" },
      }),
    ).rejects.toThrow(ServiceUnavailableError);
  });
});
