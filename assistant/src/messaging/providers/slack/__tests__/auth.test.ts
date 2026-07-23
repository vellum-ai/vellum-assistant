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

// Import the real SlackApiError so runAsUserWithBotFallback's `instanceof`
// check and the test share the same class. Do NOT mock the whole client module
// here — a mock.module("../client.js") leaks across test files and strips the
// real listConversations/postMessage the adapter tests rely on.
const { resolveSlackAuth, runAsUserWithBotFallback } =
  await import("../auth.js");
const { SlackApiError } = await import("../client.js");

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

describe("runAsUserWithBotFallback", () => {
  test("runs as the user (user token) when the call succeeds", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    const seen: unknown[] = [];
    const result = await runAsUserWithBotFallback("xoxb-bot", async (auth) => {
      seen.push(auth);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["xoxp-user"]);
  });

  test("retries with the bot token when the user token is rejected (401)", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    const seen: unknown[] = [];
    const result = await runAsUserWithBotFallback("xoxb-bot", async (auth) => {
      seen.push(auth);
      if (auth === "xoxp-user") {
        throw new SlackApiError(401, "invalid_auth", "bad token");
      }
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(seen).toEqual(["xoxp-user", "xoxb-bot"]);
  });

  test("does not retry when the user auth is already the bot token", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot"); // no user token → user === bot
    let calls = 0;
    await expect(
      runAsUserWithBotFallback("xoxb-bot", async () => {
        calls += 1;
        throw new SlackApiError(401, "invalid_auth", "bad token");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("does not retry non-401 errors by default", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    let calls = 0;
    await expect(
      runAsUserWithBotFallback("xoxb-bot", async () => {
        calls += 1;
        throw new SlackApiError(500, "internal_error", "boom");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("a custom shouldFallback widens the retry to non-401 errors (missing_scope)", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    const seen: unknown[] = [];
    // missing_scope maps to status 400, so the default predicate would NOT
    // retry — this is the share-post path, where the user token can lack
    // chat:write and the bot token can still post.
    const result = await runAsUserWithBotFallback(
      "xoxb-bot",
      async (auth) => {
        seen.push(auth);
        if (auth === "xoxp-user") {
          throw new SlackApiError(400, "missing_scope", "no chat:write");
        }
        return "posted-as-bot";
      },
      {
        shouldFallback: (err) =>
          err.status === 401 || err.slackError === "missing_scope",
      },
    );
    expect(result).toBe("posted-as-bot");
    expect(seen).toEqual(["xoxp-user", "xoxb-bot"]);
  });
});
