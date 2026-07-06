import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ServiceUnavailableError } from "../runtime/routes/errors.js";

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
let userInfoResults: Map<string, unknown> = new Map();

mock.module("../messaging/providers/slack/client.js", () => ({
  listConversations: async () => listConversationsResult,
  userInfo: async (_token: string, userId: string) => {
    const result = userInfoResults.get(userId);
    if (result) {
      return result;
    }
    throw new Error(`User not found: ${userId}`);
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

const { handleListSlackChannels } =
  await import("../runtime/routes/integrations/slack/channels.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function configureToken() {
  connectionByProvider["slack"] = { id: "conn-slack-1" };
  secureKeyValues.set(
    "oauth_connection/conn-slack-1/access_token",
    "xoxb-test",
  );
}

beforeEach(() => {
  secureKeyValues.clear();
  connectionByProvider = {};
  listConversationsResult = { ok: true, channels: [] };
  userInfoResults = new Map();
});

describe("handleListSlackChannels", () => {
  test("throws ServiceUnavailableError when no token is configured", async () => {
    expect(handleListSlackChannels()).rejects.toThrow(ServiceUnavailableError);
  });

  test("returns channels sorted by type then name", async () => {
    configureToken();

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
      channels: Array<Record<string, unknown>>;
    };

    expect(result.channels).toHaveLength(4);
    expect(result.channels[0]).toEqual({
      id: "C1",
      name: "alpha-channel",
      type: "channel",
      isPrivate: false,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
    expect(result.channels[1]).toEqual({
      id: "C2",
      name: "beta-channel",
      type: "channel",
      isPrivate: false,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
    expect(result.channels[2]).toEqual({
      id: "G1",
      name: "group-chat",
      type: "group",
      isPrivate: true,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
    expect(result.channels[3]).toEqual({
      id: "D1",
      name: "Alice Smith",
      type: "dm",
      isPrivate: true,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
  });

  test("maps isMember, memberCount, topic, and purpose fallback from the raw payload", async () => {
    configureToken();

    listConversationsResult = {
      ok: true,
      channels: [
        {
          id: "C1",
          name: "with-topic",
          is_channel: true,
          is_member: true,
          num_members: 42,
          topic: { value: "P2 incident triage" },
          purpose: { value: "unused purpose" },
        },
        {
          id: "C2",
          name: "purpose-fallback",
          is_channel: true,
          num_members: 7,
          topic: { value: "" },
          purpose: { value: "Escalation hand-offs" },
        },
        {
          id: "C3",
          name: "bare-channel",
          is_channel: true,
        },
      ],
    };

    const result = (await handleListSlackChannels()) as {
      channels: Array<Record<string, unknown>>;
    };

    expect(result.channels[0]).toEqual({
      id: "C3",
      name: "bare-channel",
      type: "channel",
      isPrivate: false,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
    expect(result.channels[1]).toEqual({
      id: "C2",
      name: "purpose-fallback",
      type: "channel",
      isPrivate: false,
      isMember: false,
      memberCount: 7,
      topic: "Escalation hand-offs",
      imageUrl: null,
    });
    expect(result.channels[2]).toEqual({
      id: "C1",
      name: "with-topic",
      type: "channel",
      isPrivate: false,
      isMember: true,
      memberCount: 42,
      topic: "P2 incident triage",
      imageUrl: null,
    });
  });

  test("populates imageUrl on DM rows from the userInfo profile", async () => {
    configureToken();

    listConversationsResult = {
      ok: true,
      channels: [
        { id: "D1", is_im: true, user: "U1", is_private: true },
        { id: "D2", is_im: true, user: "U2", is_private: true },
      ],
    };

    userInfoResults.set("U1", {
      ok: true,
      user: {
        id: "U1",
        name: "alice",
        profile: {
          display_name: "Alice Smith",
          image_48: "https://avatars.example.com/u1_48.png",
        },
      },
    });
    userInfoResults.set("U2", {
      ok: true,
      user: {
        id: "U2",
        name: "bob",
        profile: { display_name: "Bob Jones" },
      },
    });

    const result = (await handleListSlackChannels()) as {
      channels: Array<Record<string, unknown>>;
    };

    expect(result.channels[0]).toEqual({
      id: "D1",
      name: "Alice Smith",
      type: "dm",
      isPrivate: true,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: "https://avatars.example.com/u1_48.png",
    });
    expect(result.channels[1]).toEqual({
      id: "D2",
      name: "Bob Jones",
      type: "dm",
      isPrivate: true,
      isMember: false,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
  });

  test("memberOnly=true filters to is_member conversations before normalizing", async () => {
    configureToken();

    listConversationsResult = {
      ok: true,
      channels: [
        { id: "C1", name: "member-channel", is_channel: true, is_member: true },
        { id: "C2", name: "other-channel", is_channel: true, is_member: false },
        { id: "D1", is_im: true, user: "U-unresolved", is_private: true },
      ],
    };

    const result = (await handleListSlackChannels({
      queryParams: { memberOnly: "true" },
    })) as { channels: Array<Record<string, unknown>> };

    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toEqual({
      id: "C1",
      name: "member-channel",
      type: "channel",
      isPrivate: false,
      isMember: true,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
  });

  test("omitting memberOnly returns all conversations", async () => {
    configureToken();

    listConversationsResult = {
      ok: true,
      channels: [
        { id: "C1", name: "member-channel", is_channel: true, is_member: true },
        { id: "C2", name: "other-channel", is_channel: true, is_member: false },
      ],
    };

    const result = (await handleListSlackChannels({})) as {
      channels: Array<Record<string, unknown>>;
    };

    expect(result.channels).toHaveLength(2);
  });
});
