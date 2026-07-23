import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const secureKeys = new Map<string, string>();
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeys.get(key),
}));

let connectionByProvider: Record<string, { id: string } | undefined> = {};
mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (provider: string) => connectionByProvider[provider],
}));

const { resolveSlackToken } =
  await import("../runtime/routes/integrations/slack/token.js");

const BOT_KEY = "credential/slack_channel/bot_token";
const USER_KEY = "credential/slack_channel/user_token";

beforeEach(() => {
  secureKeys.clear();
  connectionByProvider = {};
});

describe("resolveSlackToken", () => {
  test("bot-read returns the bot token even when a user token is present", async () => {
    // The presence list must reflect the bot's own membership, so it must not
    // pick up the optional user token (whose view is the user's channels).
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    expect(await resolveSlackToken("bot-read")).toBe("xoxb-bot");
  });

  test("read prefers the user token when one is stored (broader share-picker reach)", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    expect(await resolveSlackToken("read")).toBe("xoxp-user");
  });

  test("read falls back to the bot token when no user token is stored", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    expect(await resolveSlackToken("read")).toBe("xoxb-bot");
  });

  test("write always returns the bot token", async () => {
    secureKeys.set(BOT_KEY, "xoxb-bot");
    secureKeys.set(USER_KEY, "xoxp-user");
    expect(await resolveSlackToken("write")).toBe("xoxb-bot");
  });

  test("bot-read falls back to the OAuth connection token for legacy installs", async () => {
    // No Socket Mode bot token — the OAuth connection's access_token is the
    // bot token in Slack's OAuth v2 flow.
    connectionByProvider["slack"] = { id: "conn-1" };
    secureKeys.set("oauth_connection/conn-1/access_token", "xoxb-oauth");
    expect(await resolveSlackToken("bot-read")).toBe("xoxb-oauth");
  });

  test("returns undefined when no Slack credentials exist", async () => {
    expect(await resolveSlackToken("bot-read")).toBeUndefined();
  });
});
