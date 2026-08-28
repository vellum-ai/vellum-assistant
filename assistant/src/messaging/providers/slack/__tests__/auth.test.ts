import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const secureKeys = new Map<string, string>();
mock.module("../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeys.get(key),
}));

let connectionByProvider: Record<string, { id: string } | undefined> = {};
mock.module("../../../../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (provider: string) => connectionByProvider[provider],
  isProviderConnected: async () => false,
}));

let oauthConnection: unknown = null;
const resolveOAuthCalls: Array<{ provider: string; opts: unknown }> = [];
mock.module("../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (provider: string, opts: unknown) => {
    resolveOAuthCalls.push({ provider, opts });
    if (oauthConnection === null) {
      throw new Error("No OAuth connection found for slack");
    }
    return oauthConnection;
  },
}));

const { resolveSlackAuth } = await import("../auth.js");

const BOT_KEY = "credential/slack_channel/bot_token";
const USER_KEY = "credential/slack_channel/user_token";

beforeEach(() => {
  secureKeys.clear();
  connectionByProvider = {};
  oauthConnection = null;
  resolveOAuthCalls.length = 0;
});

describe("resolveSlackAuth", () => {
  test("bot intent returns the bot token even when a user token is stored", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    expect(await resolveSlackAuth("bot")).toBe("xoxb-bot");
  });

  test("user intent prefers the user token when stored", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    expect(await resolveSlackAuth("user")).toBe("xoxp-user");
  });

  test("user intent falls back to the bot token without a user token", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    expect(await resolveSlackAuth("user")).toBe("xoxb-bot");
    // No connection row, so the OAuth rung is skipped rather than probed.
    expect(resolveOAuthCalls).toEqual([]);
  });

  test("user intent takes the OAuth connection over the bot token", async () => {
    // Both are the installer's own token. Degrading to the bot here would
    // drop `search.messages`, which a bot token cannot call, while a usable
    // user token sat in the connection.
    secureKeys.set(BOT_KEY, "xoxb-bot");
    connectionByProvider["slack"] = { id: "conn-1" };
    oauthConnection = { accessToken: "xoxp-oauth" };

    expect((await resolveSlackAuth("user")) as unknown).toBe(oauthConnection);
  });

  test("the pasted user token still wins over an OAuth connection", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    connectionByProvider["slack"] = { id: "conn-1" };
    oauthConnection = { accessToken: "xoxp-oauth" };

    expect(await resolveSlackAuth("user")).toBe("xoxp-user");
    // Resolved from the credential store, so the connection is never touched.
    expect(resolveOAuthCalls).toEqual([]);
  });

  test("an unresolvable OAuth connection degrades to the bot token", async () => {
    // A revoked or unrefreshable connection must not take messaging down: the
    // bot token still serves every read it can.
    secureKeys.set(BOT_KEY, "xoxb-bot");
    connectionByProvider["slack"] = { id: "conn-1" };
    oauthConnection = null; // the mock throws for this

    expect(await resolveSlackAuth("user")).toBe("xoxb-bot");
    expect(resolveOAuthCalls).toHaveLength(1);
  });

  test("resolves the refreshing OAuth connection for legacy installs", async () => {
    connectionByProvider["slack"] = { id: "conn-1" };
    oauthConnection = { accessToken: "xoxb-oauth" };
    expect((await resolveSlackAuth("bot")) as unknown).toBe(oauthConnection);
    expect(resolveOAuthCalls).toEqual([
      { provider: "slack", opts: { account: undefined } },
    ]);
  });

  test("returns undefined (without resolving) when no Slack credentials exist", async () => {
    expect(await resolveSlackAuth("user")).toBeUndefined();
    // Guarded by the connection-row check — never reaches resolveOAuthConnection.
    expect(resolveOAuthCalls).toEqual([]);
  });
});
