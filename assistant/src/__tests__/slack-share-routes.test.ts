import { beforeEach, describe, expect, mock, test } from "bun:test";

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
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/v1/slack/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
  test("returns 503 when no token is configured", async () => {
    const res = await handleListSlackChannels();
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  test("returns channels sorted by type then name", async () => {
    connectionByProvider["integration:slack"] = { id: "conn-slack-1" };
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

    const res = await handleListSlackChannels();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      channels: Array<{
        id: string;
        name: string;
        type: string;
        isPrivate: boolean;
      }>;
    };

    expect(json.channels).toHaveLength(4);
    // Channels first (alphabetical)
    expect(json.channels[0]).toEqual({
      id: "C1",
      name: "alpha-channel",
      type: "channel",
      isPrivate: false,
    });
    expect(json.channels[1]).toEqual({
      id: "C2",
      name: "beta-channel",
      type: "channel",
      isPrivate: false,
    });
    // Groups
    expect(json.channels[2]).toEqual({
      id: "G1",
      name: "group-chat",
      type: "group",
      isPrivate: true,
    });
    // DMs (name resolved from userInfo)
    expect(json.channels[3]).toEqual({
      id: "D1",
      name: "Alice Smith",
      type: "dm",
      isPrivate: true,
    });
  });
});

describe("handleShareToSlackChannel", () => {
  test("returns 503 when no token is configured", async () => {
    const req = makeRequest({ appId: "app1", channelId: "C1" });
    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(503);
  });

  test("returns 400 for malformed JSON", async () => {
    connectionByProvider["integration:slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
    const req = new Request("http://localhost/v1/slack/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(400);
  });

  test("returns 400 when missing required fields", async () => {
    connectionByProvider["integration:slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
    const req = makeRequest({ appId: "app1" });
    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Missing required fields");
  });

  test("returns 404 when app not found", async () => {
    connectionByProvider["integration:slack"] = { id: "conn-slack-1" };
    secureKeyValues.set(
      "oauth_connection/conn-slack-1/access_token",
      "xoxb-test",
    );
    appStoreResult = null;
    const req = makeRequest({ appId: "missing-app", channelId: "C1" });
    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(404);
  });

  test("posts message and returns success", async () => {
    connectionByProvider["integration:slack"] = { id: "conn-slack-1" };
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

    const req = makeRequest({
      appId: "app1",
      channelId: "C123",
      message: "Check this out!",
    });
    const res = await handleShareToSlackChannel(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      ts: string;
      channel: string;
    };
    expect(json.ok).toBe(true);
    expect(json.ts).toBe("1234567890.123456");
    expect(json.channel).toBe("C123");
  });
});
