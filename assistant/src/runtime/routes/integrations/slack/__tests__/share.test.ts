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

// ── Module mocks ────────────────────────────────────────────────────────────

const getSecureKeyAsyncMock = mock(
  async (_key: string): Promise<string | null> => null,
);
mock.module("../../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

// share.ts imports getConnectionByProvider from oauth-store at module load.
// Stub it to return undefined so Socket Mode tokens are the only source.
mock.module("../../../../../oauth/oauth-store.js", () => ({
  getConnectionByProvider: () => undefined,
}));

// Stub the app store so handleShareToSlackChannel finds the app.
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

    // Minimal OK Slack envelopes so handlers don't throw on shape mismatches.
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

const BOT_TOKEN = "xoxb-BOT";
const USER_TOKEN = "xoxp-USER";

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

    const res = await handleListSlackChannels();
    expect(res.status).toBe(200);

    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("GET /v1/slack/channels: bot + user tokens prefer user_token for reads", async () => {
    // Core fix: with both tokens stored, the Share UI picker must see every
    // channel the USER can see — not just ones the bot is a member of.
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    const res = await handleListSlackChannels();
    expect(res.status).toBe(200);

    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  test("POST /v1/slack/share: bot + user tokens still write with bot token", async () => {
    // SAFETY invariant: posts MUST come from the bot identity. If the handler
    // ever routed the write through user_token, the posted message would
    // appear as the user — unambiguously wrong.
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return BOT_TOKEN;
      if (key === credentialKey("slack_channel", "user_token"))
        return USER_TOKEN;
      return null;
    });

    const req = new Request("http://localhost/v1/slack/share", {
      method: "POST",
      body: JSON.stringify({ appId: FAKE_APP.id, channelId: "C123" }),
    });

    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(200);

    const postCall = captured.find((c) => c.url.includes("/chat.postMessage"));
    expect(postCall).toBeDefined();
    expect(postCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("no tokens configured: both handlers return 503", async () => {
    getSecureKeyAsyncMock.mockImplementation(async () => null);

    const listRes = await handleListSlackChannels();
    expect(listRes.status).toBe(503);

    const shareReq = new Request("http://localhost/v1/slack/share", {
      method: "POST",
      body: JSON.stringify({ appId: FAKE_APP.id, channelId: "C123" }),
    });
    const shareRes = await handleShareToSlackChannel(shareReq);
    expect(shareRes.status).toBe(503);
  });
});
