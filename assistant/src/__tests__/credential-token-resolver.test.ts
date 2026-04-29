import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable state for mocks ──────────────────────────────────────────

const secureKeyValues = new Map<string, string>();
const unreachableKeys = new Set<string>();

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
  getSecureKeyResultAsync: async (account: string) => ({
    value: secureKeyValues.get(account),
    unreachable: unreachableKeys.has(account),
  }),
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => "deleted",
  listSecureKeysAsync: async () => [],
  getProviderKeyAsync: async () => undefined,
  getMaskedProviderKey: () => undefined,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// ── Import under test ────────────────────────────────────────────────

const { resolveAccessTokenKey, getConnectionAccessTokenResult } =
  await import("../oauth/credential-token-resolver.js");

// ── Tests ────────────────────────────────────────────────────────────

describe("credential-token-resolver", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    unreachableKeys.clear();
  });

  describe("resolveAccessTokenKey", () => {
    test("slack_channel resolves to credential/slack_channel/bot_token", () => {
      expect(resolveAccessTokenKey("slack_channel", "conn-123")).toBe(
        "credential/slack_channel/bot_token",
      );
    });

    test("telegram resolves to credential/telegram/bot_token", () => {
      expect(resolveAccessTokenKey("telegram", "conn-456")).toBe(
        "credential/telegram/bot_token",
      );
    });

    test("standard OAuth provider resolves to oauth_connection/<id>/access_token", () => {
      expect(resolveAccessTokenKey("google", "conn-789")).toBe(
        "oauth_connection/conn-789/access_token",
      );
    });

    test("unknown provider resolves to oauth_connection/<id>/access_token", () => {
      expect(resolveAccessTokenKey("github", "conn-abc")).toBe(
        "oauth_connection/conn-abc/access_token",
      );
    });
  });

  describe("getConnectionAccessTokenResult", () => {
    test("returns token value and key for slack_channel using bot_token path", async () => {
      secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-valid");

      const result = await getConnectionAccessTokenResult({
        provider: "slack_channel",
        connectionId: "conn-slack",
      });

      expect(result.value).toBe("xoxb-valid");
      expect(result.unreachable).toBe(false);
      expect(result.key).toBe("credential/slack_channel/bot_token");
    });

    test("returns undefined for slack_channel when bot_token is absent even if oauth path is set", async () => {
      // Simulate the bug scenario: OAuth access-token path is populated but
      // the manual-token path is not. The resolver must NOT fall through to
      // the OAuth path for manual-token providers.
      secureKeyValues.set(
        "oauth_connection/conn-slack/access_token",
        "should-be-ignored",
      );

      const result = await getConnectionAccessTokenResult({
        provider: "slack_channel",
        connectionId: "conn-slack",
      });

      expect(result.value).toBeUndefined();
      expect(result.key).toBe("credential/slack_channel/bot_token");
    });

    test("returns token for standard OAuth provider via connection path", async () => {
      secureKeyValues.set(
        "oauth_connection/conn-google/access_token",
        "ya29.token",
      );

      const result = await getConnectionAccessTokenResult({
        provider: "google",
        connectionId: "conn-google",
      });

      expect(result.value).toBe("ya29.token");
      expect(result.unreachable).toBe(false);
      expect(result.key).toBe("oauth_connection/conn-google/access_token");
    });

    test("returns unreachable when credential backend is down", async () => {
      unreachableKeys.add("credential/telegram/bot_token");

      const result = await getConnectionAccessTokenResult({
        provider: "telegram",
        connectionId: "conn-tg",
      });

      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(true);
      expect(result.key).toBe("credential/telegram/bot_token");
    });

    test("returns undefined (not unreachable) when token is genuinely missing", async () => {
      const result = await getConnectionAccessTokenResult({
        provider: "google",
        connectionId: "conn-missing",
      });

      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
      expect(result.key).toBe("oauth_connection/conn-missing/access_token");
    });
  });

  describe("regression: oauth ping slack_channel uses bot_token", () => {
    // The root cause of false credential health alerts was that some code paths
    // looked up tokens at oauth_connection/<id>/access_token for ALL providers,
    // while manual-token providers (slack_channel, telegram) actually store
    // their tokens at credential/<provider>/bot_token. The centralized resolver
    // ensures ALL consumers agree on the path.

    test("slack_channel token lookup goes to credential/slack_channel/bot_token, not oauth path", async () => {
      secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-real");

      const result = await getConnectionAccessTokenResult({
        provider: "slack_channel",
        connectionId: "any-connection-id",
      });

      // Must find the token at the manual-token path
      expect(result.value).toBe("xoxb-real");
      // Must report the correct key
      expect(result.key).toBe("credential/slack_channel/bot_token");
      // Connection ID must be irrelevant for manual-token providers
      expect(result.key).not.toContain("any-connection-id");
    });

    test("telegram token lookup goes to credential/telegram/bot_token, not oauth path", async () => {
      secureKeyValues.set("credential/telegram/bot_token", "tg-token");

      const result = await getConnectionAccessTokenResult({
        provider: "telegram",
        connectionId: "any-connection-id",
      });

      expect(result.value).toBe("tg-token");
      expect(result.key).toBe("credential/telegram/bot_token");
      expect(result.key).not.toContain("any-connection-id");
    });
  });
});
