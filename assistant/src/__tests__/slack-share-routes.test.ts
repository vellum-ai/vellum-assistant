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

let postMessageResult: unknown = {
  ok: true,
  ts: "1234567890.123456",
  channel: "C123",
  message: { ts: "1234567890.123456", text: "", type: "message" },
};

mock.module("../messaging/providers/slack/client.js", () => ({
  postMessage: async (
    _token: string,
    _channel: string,
    _text: string,
    _opts?: unknown,
  ) => postMessageResult,
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
    connectionByProvider["slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
    expect(
      handleShareToSlackChannel({ body: { appId: "app1" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("throws NotFoundError when app not found", async () => {
    connectionByProvider["slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
    appStoreResult = null;
    expect(
      handleShareToSlackChannel({
        body: { appId: "missing-app", channelId: "C1" },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("posts message and returns success", async () => {
    connectionByProvider["slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
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
