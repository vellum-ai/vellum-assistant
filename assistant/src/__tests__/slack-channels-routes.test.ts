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

// The route handler resolves auth via messaging/providers/slack/auth.ts, which
// imports the OAuth connection resolver. Socket Mode (bot token) never reaches
// it, but the module must be stubbed so the import graph loads under the
// partial secure-keys mock.
mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => {
    throw new Error("No OAuth connection (Socket Mode test)");
  },
}));

let listConversationsResult: unknown = { ok: true, channels: [] };
mock.module("../messaging/providers/slack/client.js", () => ({
  listConversations: async () => listConversationsResult,
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
  // Socket Mode bot token — the connected Channels-page install. resolveSlackAuth
  // returns it directly for the "bot" identity, so no OAuth resolution runs.
  secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-test");
}

beforeEach(() => {
  secureKeyValues.clear();
  connectionByProvider = {};
  listConversationsResult = { ok: true, channels: [] };
});

describe("handleListSlackChannels", () => {
  test("throws ServiceUnavailableError when no token is configured", async () => {
    expect(handleListSlackChannels()).rejects.toThrow(ServiceUnavailableError);
  });

  test("returns member channels and group DMs sorted by type then name, dropping non-member and 1:1 IM rows", async () => {
    configureToken();

    listConversationsResult = {
      ok: true,
      channels: [
        // 1:1 IM — person-scoped, dropped.
        { id: "D1", is_im: true, user: "U1", is_private: true },
        // Non-member public channel — dropped (the bot can't act there).
        { id: "C3", name: "not-joined", is_channel: true, is_member: false },
        { id: "C2", name: "beta-channel", is_channel: true, is_member: true },
        { id: "C1", name: "alpha-channel", is_channel: true, is_member: true },
        // Group DM — kept.
        { id: "G1", name: "group-chat", is_mpim: true, is_private: true },
      ],
    };

    const result = (await handleListSlackChannels()) as {
      channels: Array<Record<string, unknown>>;
    };

    // Channels first (by name), then the group DM.
    expect(result.channels.map((c) => c.id)).toEqual(["C1", "C2", "G1"]);
    expect(result.channels[0]).toEqual({
      id: "C1",
      name: "alpha-channel",
      type: "channel",
      isPrivate: false,
      isMember: true,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
    expect(result.channels[2]).toEqual({
      id: "G1",
      name: "group-chat",
      type: "group",
      isPrivate: true,
      isMember: true,
      memberCount: null,
      topic: null,
      imageUrl: null,
    });
  });

  test("maps memberCount, topic, and purpose fallback from the raw payload", async () => {
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
          is_member: true,
          num_members: 7,
          topic: { value: "" },
          purpose: { value: "Escalation hand-offs" },
        },
      ],
    };

    const result = (await handleListSlackChannels()) as {
      channels: Array<Record<string, unknown>>;
    };

    // Sorted by name: "purpose-fallback" before "with-topic".
    expect(result.channels[0]).toEqual({
      id: "C2",
      name: "purpose-fallback",
      type: "channel",
      isPrivate: false,
      isMember: true,
      memberCount: 7,
      topic: "Escalation hand-offs",
      imageUrl: null,
    });
    expect(result.channels[1]).toEqual({
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
});
