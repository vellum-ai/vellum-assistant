/**
 * Wire-level token routing for the Slack routes (the routes-layer twin of
 * messaging/providers/slack/__tests__/adapter-token-routing.test.ts). Captures
 * the Authorization header the real Slack client puts on the wire, so it proves
 * each handler is actually wired to the identity slack/auth.ts resolves — a
 * class of bug the mocked-client handler tests can't catch.
 *
 * Both routes act as the BOT, and these tests are the regression guard for why:
 * `GET /v1/slack/channels` and `POST /v1/slack/share` are exposed at the gateway
 * with generic edge auth and the daemon never sees the calling actor, so acting
 * as the single stored installer `user_token` would let any caller read the
 * installer's channel list (picker) or post as them (share). So even when a
 * user_token IS stored, neither route may put it on the wire.
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
    captured.push({ url, method, authorization: headers.get("authorization") });

    return new Response(JSON.stringify(fakeSlackResponse(url)), {
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

/** Stores both tokens, so a test asserting the bot token proves the stored
 *  user_token was deliberately NOT put on the wire. */
function storeBothTokens() {
  getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
    if (key === credentialKey("slack_channel", "bot_token")) {
      return BOT_TOKEN;
    }
    if (key === credentialKey("slack_channel", "user_token")) {
      return USER_TOKEN;
    }
    return null;
  });
}

describe("Slack route token routing (channels + share)", () => {
  beforeEach(() => {
    captured.length = 0;
    getSecureKeyAsyncMock.mockReset();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /v1/slack/channels: bot-only install reads with the bot token", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
      key === credentialKey("slack_channel", "bot_token") ? BOT_TOKEN : null,
    );

    const result = (await handleListSlackChannels()) as { channels: unknown[] };
    expect(result).toHaveProperty("channels");

    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("GET /v1/slack/channels: a stored user_token is NOT used — reads stay on the bot token", async () => {
    storeBothTokens();

    const result = (await handleListSlackChannels()) as { channels: unknown[] };
    expect(result).toHaveProperty("channels");

    // Security guard: this edge-reachable route must not read as the installer.
    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("POST /v1/slack/share: posts with the bot token even when a user_token is stored", async () => {
    storeBothTokens();

    const result = (await handleShareToSlackChannel({
      body: { appId: FAKE_APP.id, channelId: "C123" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    // Security guard: shares must come from the neutral app identity, never the
    // installer's user_token — the daemon can't verify the caller is the owner.
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
