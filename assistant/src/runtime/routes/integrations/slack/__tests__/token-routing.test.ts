/**
 * Wire-level token routing for the Slack channels route (the routes-layer twin
 * of messaging/providers/slack/__tests__/adapter-token-routing.test.ts).
 * Captures the Authorization header the real Slack client puts on the wire, so
 * it proves the handler is actually wired to the identity slack/auth.ts
 * resolves — a class of bug the mocked-client handler tests can't catch.
 *
 * `GET /v1/slack/channels` acts as the BOT, and these tests are the regression
 * guard for why: it is exposed at the gateway with generic edge auth and the
 * daemon never sees the calling actor, so acting as the single stored installer
 * `user_token` would leak the installer's channel list to any caller. Even when
 * a user_token IS stored, the route must not put it on the wire.
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

// The handler resolves auth through messaging/providers/slack/auth.ts, which
// imports the OAuth connection resolver. Socket Mode (bot token) never reaches
// it, but the module must be stubbed so the import graph loads under the
// partial secure-keys mock above.
mock.module("../../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => {
    throw new Error("No OAuth connection (Socket Mode test)");
  },
}));

const { handleListSlackChannels } = await import("../channels.js");

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

    return new Response(
      JSON.stringify({
        ok: true,
        channels: [],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

// ── Test fixtures ───────────────────────────────────────────────────────────

const BOT_TOKEN = "xoxb-test-bot-token";
const USER_TOKEN = "xoxp-test-user-token";

describe("Slack channels route token routing", () => {
  beforeEach(() => {
    captured.length = 0;
    getSecureKeyAsyncMock.mockReset();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("bot-only install reads with the bot token", async () => {
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

  test("a stored user_token is NOT used — reads stay on the bot token", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) {
        return BOT_TOKEN;
      }
      if (key === credentialKey("slack_channel", "user_token")) {
        return USER_TOKEN;
      }
      return null;
    });

    const result = (await handleListSlackChannels()) as { channels: unknown[] };
    expect(result).toHaveProperty("channels");

    // Security guard: this edge-reachable route must not read as the installer.
    const listCall = captured.find((c) =>
      c.url.includes("/conversations.list"),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  test("no tokens configured: the handler throws ServiceUnavailableError", async () => {
    getSecureKeyAsyncMock.mockImplementation(async () => null);

    expect(handleListSlackChannels()).rejects.toThrow(ServiceUnavailableError);
  });
});
