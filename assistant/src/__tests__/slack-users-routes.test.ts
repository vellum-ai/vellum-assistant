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

let listUsersPages: unknown[] = [{ ok: true, members: [] }];
let listUsersCalls: Array<{ cursor: string | undefined }> = [];

mock.module("../messaging/providers/slack/client.js", () => ({
  listUsers: async (_token: string, _limit: number, cursor?: string) => {
    listUsersCalls.push({ cursor });
    return listUsersPages[listUsersCalls.length - 1];
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

const { handleListSlackUsers } =
  await import("../runtime/routes/integrations/slack/users.js");

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
  listUsersPages = [{ ok: true, members: [] }];
  listUsersCalls = [];
});

describe("handleListSlackUsers", () => {
  test("throws ServiceUnavailableError when no token is configured", async () => {
    expect(handleListSlackUsers()).rejects.toThrow(ServiceUnavailableError);
  });

  test("returns normalized users sorted by display name", async () => {
    configureToken();

    listUsersPages = [
      {
        ok: true,
        members: [
          {
            id: "U2",
            name: "bob",
            real_name: "Bob Jones",
          },
          {
            id: "U1",
            name: "alice",
            profile: {
              display_name: "Alice Smith",
              image_48: "https://avatars.example.com/u1_48.png",
            },
          },
        ],
      },
    ];

    const result = await handleListSlackUsers();

    expect(result.users).toEqual([
      {
        id: "U1",
        username: "alice",
        displayName: "Alice Smith",
        imageUrl: "https://avatars.example.com/u1_48.png",
      },
      {
        id: "U2",
        username: "bob",
        displayName: "Bob Jones",
        imageUrl: null,
      },
    ]);
  });

  test("excludes deleted users, bots, and slackbot", async () => {
    configureToken();

    listUsersPages = [
      {
        ok: true,
        members: [
          { id: "U1", name: "alice", real_name: "Alice Smith" },
          { id: "U2", name: "ghost", real_name: "Gone User", deleted: true },
          { id: "U3", name: "botuser", real_name: "Bot User", is_bot: true },
          { id: "USLACKBOT", name: "slackbot", real_name: "Slackbot" },
        ],
      },
    ];

    const result = await handleListSlackUsers();

    expect(result.users.map((u) => u.id)).toEqual(["U1"]);
  });

  test("paginates through response_metadata.next_cursor", async () => {
    configureToken();

    listUsersPages = [
      {
        ok: true,
        members: [{ id: "U1", name: "alice", real_name: "Alice Smith" }],
        response_metadata: { next_cursor: "cursor-2" },
      },
      {
        ok: true,
        members: [{ id: "U2", name: "bob", real_name: "Bob Jones" }],
        response_metadata: { next_cursor: "" },
      },
    ];

    const result = await handleListSlackUsers();

    expect(listUsersCalls).toEqual([
      { cursor: undefined },
      { cursor: "cursor-2" },
    ]);
    expect(result.users.map((u) => u.id)).toEqual(["U1", "U2"]);
  });
});
