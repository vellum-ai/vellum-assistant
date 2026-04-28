/**
 * Unit tests for the Share UI Slack route handlers.
 *
 * Verifies the read/write auth split mirrors `messaging/providers/slack/adapter.ts`:
 * - Channel enumeration (GET /v1/slack/channels) is a read path and must
 *   prefer the user_token when present so the picker surfaces channels the
 *   user is in but the bot isn't.
 * - Channel sharing (POST /v1/slack/share) is a write path and must always
 *   use the bot_token so posts come from the bot identity.
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

const FAKE_APP = { id: "app-1", name: "Test App", description: "desc" };
mock.module("../../../../../memory/app-store.js", () => ({
  getApp: (id: string) => (id === FAKE_APP.id ? FAKE_APP : undefined),
}));

const { handleListSlackChannels, handleShareToSlackChannel } = await import(
  "../share.js"
);

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
  return { ok: true };
}

// ── Test fixtures ───────────────────────────────────────────────────────────

const BOT_TOKEN = "xoxb-test-bot-token";
const USER_TOKEN = "xoxp-test-user-token";

describe("Slack share route token routing", () => {
  beforeEach(() => {
    captured.length = 0;
    getSecureKeyAsyncMock.mockReset();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /v1/slack/channels: bot-only install reads with bot token", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
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
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
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

  test("POST /v1/slack/share: bot + user tokens still write with bot token", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    const result = (await handleShareToSlackChannel({
      body: { appId: FAKE_APP.id, channelId: "C123" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const postCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall).toBeDefined();
    expect(postCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
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
