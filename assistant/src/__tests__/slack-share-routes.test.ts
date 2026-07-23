import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that pull in mocked modules
// ---------------------------------------------------------------------------

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

// Match the real SlackApiError shape (status + slackError) so the share
// handler's `shouldFallback` predicate and the fallback wrapper's `instanceof`
// check both work against tokens thrown from these tests.
class SlackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly slackError: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

// Records every postMessage attempt so tests can assert WHICH token posted.
let postMessageTokens: unknown[] = [];
// When set, postMessage throws this error for the user token (xoxp-*), leaving
// the bot token to succeed — exercises the user→bot fallback.
let userTokenPostError: SlackApiError | null = null;

mock.module("../messaging/providers/slack/client.js", () => ({
  postMessage: async (
    token: unknown,
    _channel: string,
    _text: string,
    _opts?: unknown,
  ) => {
    postMessageTokens.push(token);
    if (
      userTokenPostError &&
      typeof token === "string" &&
      token.startsWith("xoxp-")
    ) {
      throw userTokenPostError;
    }
    return postMessageResult;
  },
  // auth.ts imports SlackApiError from the client; export it from the mock.
  SlackApiError,
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
  postMessageTokens = [];
  userTokenPostError = null;
  postMessageResult = {
    ok: true,
    ts: "1234567890.123456",
    channel: "C123",
    message: { ts: "1234567890.123456", text: "", type: "message" },
  };
});

/** An app that exists in the store, so share reaches the postMessage step. */
function configureApp() {
  appStoreResult = {
    id: "app1",
    name: "My App",
    description: "A great app",
    htmlDefinition: "<div></div>",
    schemaJson: "{}",
    createdAt: 0,
    updatedAt: 0,
  };
}

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

  test("posts as the user token when one is stored (human-initiated share)", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    secureKeyValues.set("credential/slack_channel/user_token", "xoxp-user");
    configureApp();

    const result = (await handleShareToSlackChannel({
      body: { appId: "app1", channelId: "C123" },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    // No fallback: the user token posted once, as the human who shared.
    expect(postMessageTokens).toEqual(["xoxp-user"]);
  });

  test("posts as the bot when no user token is stored", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    configureApp();

    await handleShareToSlackChannel({
      body: { appId: "app1", channelId: "C1" },
    });

    expect(postMessageTokens).toEqual(["xoxb-test"]);
  });

  test("falls back to the bot token when the user token is revoked (401)", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    secureKeyValues.set("credential/slack_channel/user_token", "xoxp-user");
    configureApp();
    userTokenPostError = new SlackApiError(401, "invalid_auth", "revoked");

    const result = (await handleShareToSlackChannel({
      body: { appId: "app1", channelId: "C123" },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(postMessageTokens).toEqual(["xoxp-user", "xoxb-test"]);
  });

  test("falls back to the bot token when the user token lacks chat:write (missing_scope)", async () => {
    secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
    secureKeyValues.set("credential/slack_channel/user_token", "xoxp-user");
    configureApp();
    userTokenPostError = new SlackApiError(
      400,
      "missing_scope",
      "no chat:write",
    );

    const result = (await handleShareToSlackChannel({
      body: { appId: "app1", channelId: "C123" },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(postMessageTokens).toEqual(["xoxp-user", "xoxb-test"]);
  });
});
