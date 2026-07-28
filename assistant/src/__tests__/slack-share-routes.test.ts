import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that pull in mocked modules
// ---------------------------------------------------------------------------
//
// This file covers the share HANDLER's contract: token-not-configured, input
// validation, app lookup, and the success response shape. Which Slack identity
// the post authenticates as (always the bot) is proven end-to-end at the wire
// level in the routes' token-routing.test.ts, so it is deliberately not
// re-asserted here.

const secureKeyValues = new Map<string, string>();
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeyValues.get(key),
  setSecureKeyAsync: async () => {},
}));

let connectionByProvider: Record<string, unknown> = {};
mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (key: string) =>
    connectionByProvider[key] ?? undefined,
}));

// The route resolves auth via messaging/providers/slack/auth.ts, which imports
// the OAuth connection resolver; stub it so the import graph loads (Socket Mode
// never reaches it).
mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => {
    throw new Error("No OAuth connection (Socket Mode test)");
  },
}));

let postMessageResult: unknown = {
  ok: true,
  ts: "1234567890.123456",
  channel: "C123",
  message: { ts: "1234567890.123456", text: "", type: "message" },
};

mock.module("../messaging/providers/slack/client.js", () => ({
  postMessage: async (
    _token: unknown,
    _channel: string,
    _text: string,
    _opts?: unknown,
  ) => postMessageResult,
  // auth.ts imports SlackApiError from the client; export it so the import
  // graph loads (this file never triggers the fallback that inspects it).
  SlackApiError: class SlackApiError extends Error {},
}));

let appStoreResult: unknown = null;
mock.module("../apps/app-store.js", () => ({
  getApp: (_id: string) => appStoreResult,
  getAppsDir: () => "/tmp/apps",
  listApps: () => [],
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

const { handleShareToSlackChannel } =
  await import("../runtime/routes/integrations/slack/share.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  secureKeyValues.clear();
  connectionByProvider = {};
  appStoreResult = null;
  postMessageResult = {
    ok: true,
    ts: "1234567890.123456",
    channel: "C123",
    message: { ts: "1234567890.123456", text: "", type: "message" },
  };
});

describe("handleShareToSlackChannel", () => {
  test("throws ServiceUnavailableError when no token is configured", async () => {
    expect(
      handleShareToSlackChannel({
        body: { appId: "app1", channelId: "C1" },
      }),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  test("throws BadRequestError when missing required fields", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    expect(
      handleShareToSlackChannel({ body: { appId: "app1" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("throws NotFoundError when app not found", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    appStoreResult = null;
    expect(
      handleShareToSlackChannel({
        body: { appId: "missing-app", channelId: "C1" },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("posts message and returns success", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    appStoreResult = {
      id: "app1",
      name: "My App",
      description: "A great app",
      htmlDefinition: "<div></div>",
      schemaJson: "{}",
      createdAt: 0,
      updatedAt: 0,
    };

    const result = (await handleShareToSlackChannel({
      body: { appId: "app1", channelId: "C123", message: "Check this out!" },
    })) as { ok: boolean; ts: string; channel: string };

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1234567890.123456");
    expect(result.channel).toBe("C123");
  });
});
