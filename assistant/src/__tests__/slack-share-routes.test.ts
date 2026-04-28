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

let listConversationsResult: unknown = { ok: true, channels: [] };
let postMessageResult: unknown = {
  ok: true,
  ts: "1234567890.123456",
  channel: "C123",
  message: { ts: "1234567890.123456", text: "", type: "message" },
};
let userInfoResults: Map<string, unknown> = new Map();

mock.module("../messaging/providers/slack/client.js", () => ({
  listConversations: async () => listConversationsResult,
  postMessage: async (
    _token: string,
    _channel: string,
    _text: string,
    _opts?: unknown,
  ) => postMessageResult,
  userInfo: async (_token: string, userId: string) => {
    const result = userInfoResults.get(userId);
    if (result) return result;
    throw new Error(`User not found: ${userId}`);
  },
}));

let appStoreResult: unknown = null;
mock.module("../memory/app-store.js", () => ({
  getApp: (_id: string) => appStoreResult,
  getAppsDir: () => "/tmp/apps",
  isMultifileApp: () => false,
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

const { handleListSlackChannels, handleShareToSlackChannel } =
  await import("../runtime/routes/integrations/slack/share.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  secureKeyValues.clear();
  connectionByProvider = {};
  listConversationsResult = { ok: true, channels: [] };
  userInfoResults = new Map();
  appStoreResult = null;
  postMessageResult = {
    ok: true,
    ts: "1234567890.123456",
    channel: "C123",
    message: { ts: "1234567890.123456", text: "", type: "message" },
  };
});

describe("handleListSlackChannels", () => {
  test("throws ServiceUnavailableError when no token is configured", async () => {
    expect(handleListSlackChannels()).rejects.toThrow(ServiceUnavailableError);
  });

  test("returns channels sorted by type then name", async () => {
    connectionByProvider["slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );

    listConversationsResult = {
      ok: true,
      channels: [
        {
          id: "D1",
          name: undefined,
          is_im: true,
          user: "U1",
          is_private: true,
        },
        { id: "C2", name: "beta-channel", is_channel: true },
        { id: "C1", name: "alpha-channel", is_channel: true },
        { id: "G1", name: "group-chat", is_mpim: true, is_private: true },
      ],
    };

    userInfoResults.set("U1", {
      ok: true,
      user: {
        id: "U1",
        name: "alice",
        profile: { display_name: "Alice Smith" },
      },
    });

    const result = (await handleListSlackChannels()) as {
      channels: Array<{
        id: string;
        name: string;
        type: string;
        isPrivate: boolean;
      }>;
    };

    expect(result.channels).toHaveLength(4);
    expect(result.channels[0]).toEqual({
      id: "C1",
      name: "alpha-channel",
      type: "channel",
      isPrivate: false,
    });
    expect(result.channels[1]).toEqual({
      id: "C2",
      name: "beta-channel",
      type: "channel",
      isPrivate: false,
    });
    expect(result.channels[2]).toEqual({
      id: "G1",
      name: "group-chat",
      type: "group",
      isPrivate: true,
    });
    expect(result.channels[3]).toEqual({
      id: "D1",
      name: "Alice Smith",
      type: "dm",
      isPrivate: true,
    });
  });
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
