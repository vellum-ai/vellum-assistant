import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../oauth/connection.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

const getSecureKeyAsyncMock = mock(
  async (_key: string): Promise<string | null> => null,
);
const isProviderConnectedMock = mock(
  async (_service: string): Promise<boolean> => false,
);
const resolveOAuthConnectionMock = mock(
  async (
    _service: string,
    _opts?: { account?: string },
  ): Promise<OAuthConnection> =>
    ({ accessToken: "oauth-token" }) as OAuthConnection,
);
const getConnectionByProviderMock = mock(
  (_provider: string): { status: string } | undefined => undefined,
);

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

mock.module("../oauth/oauth-store.js", () => ({
  isProviderConnected: isProviderConnectedMock,
  getConnectionByProvider: getConnectionByProviderMock,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: resolveOAuthConnectionMock,
}));

// Telegram adapter imports modules that need more stubs
mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://localhost:3000",
}));
mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: async () => "conv-1",
}));
mock.module("../memory/external-conversation-store.js", () => ({
  getExternalConversation: () => undefined,
  setExternalConversation: () => {},
}));
mock.module("../runtime/auth/token-service.js", () => ({
  mintDaemonDeliveryToken: async () => "delivery-token",
}));

// Slack client stubs (not exercised in these tests, but required on import)
mock.module("../messaging/providers/slack/client.js", () => ({}));

// Gmail client stubs
mock.module("../messaging/providers/gmail/client.js", () => ({}));
mock.module("../messaging/providers/gmail/people-client.js", () => ({}));

// Telegram client stubs
mock.module("../messaging/providers/telegram-bot/client.js", () => ({}));

import {
  getProviderConnection,
  resolveProvider,
} from "../config/bundled-skills/messaging/tools/shared.js";
import { gmailMessagingProvider } from "../messaging/providers/gmail/adapter.js";
import { slackProvider } from "../messaging/providers/slack/adapter.js";
import { telegramBotMessagingProvider } from "../messaging/providers/telegram-bot/adapter.js";
import {
  getConnectedProviders,
  registerMessagingProvider,
} from "../messaging/registry.js";

// Register providers for integration tests
registerMessagingProvider(slackProvider);
registerMessagingProvider(gmailMessagingProvider);
registerMessagingProvider(telegramBotMessagingProvider);

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetAllMocks() {
  getSecureKeyAsyncMock.mockReset();
  getSecureKeyAsyncMock.mockImplementation(async () => null);
  isProviderConnectedMock.mockReset();
  isProviderConnectedMock.mockImplementation(async () => false);
  resolveOAuthConnectionMock.mockReset();
  resolveOAuthConnectionMock.mockImplementation(
    async () => ({ accessToken: "oauth-token" }) as OAuthConnection,
  );
  getConnectionByProviderMock.mockReset();
  getConnectionByProviderMock.mockImplementation(() => undefined);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Slack messaging token resolution", () => {
  beforeEach(resetAllMocks);

  // ── slackProvider.isConnected() ─────────────────────────────────────────

  describe("slackProvider.isConnected()", () => {
    test("returns true when slack_channel bot token exists in credential store", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-bot-token" : null,
      );

      expect(await slackProvider.isConnected!()).toBe(true);
    });

    test("returns true even if slack_channel connection row is missing (backfill failure resilience)", async () => {
      // Bot token exists but no connection row — isConnected should still return true
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-bot-token" : null,
      );
      // No getConnectionByProvider call expected — Slack adapter checks token first

      expect(await slackProvider.isConnected!()).toBe(true);
    });

    test("returns true when only integration:slack has active OAuth connection (backwards compat)", async () => {
      // No bot token
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      // But OAuth provider is connected
      isProviderConnectedMock.mockImplementation(async (service: string) =>
        service === "integration:slack" ? true : false,
      );

      expect(await slackProvider.isConnected!()).toBe(true);
    });

    test("returns false when neither credential path exists", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      isProviderConnectedMock.mockImplementation(async () => false);

      expect(await slackProvider.isConnected!()).toBe(false);
    });
  });

  // ── slackProvider.resolveConnection() ───────────────────────────────────

  describe("slackProvider.resolveConnection()", () => {
    test("returns bot token string when Socket Mode credentials exist", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token"
          ? "xoxb-socket-token"
          : null,
      );

      const result = await slackProvider.resolveConnection!();
      expect(result).toBe("xoxb-socket-token");
    });

    test("returns bot token string even without a slack_channel connection row (token-only resilience)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-token-only" : null,
      );
      // No connection row — resolveConnection should still return the token

      const result = await slackProvider.resolveConnection!();
      expect(result).toBe("xoxb-token-only");
    });

    test("returns OAuthConnection when only OAuth integration:slack credentials exist (backwards compat)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      const oauthConn = {
        accessToken: "xoxp-oauth-token",
      } as OAuthConnection;
      resolveOAuthConnectionMock.mockImplementation(async () => oauthConn);

      const result = await slackProvider.resolveConnection!();
      expect(result).toBe(oauthConn);
      expect(resolveOAuthConnectionMock).toHaveBeenCalledWith(
        "integration:slack",
        { account: undefined },
      );
    });

    test("throws when no credentials exist at all (no Socket Mode, no OAuth)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      resolveOAuthConnectionMock.mockImplementation(async () => {
        throw new Error("No OAuth connection found for integration:slack");
      });

      await expect(slackProvider.resolveConnection!()).rejects.toThrow(
        "No OAuth connection found",
      );
    });
  });

  // ── getProviderConnection() integration ─────────────────────────────────

  describe("getProviderConnection()", () => {
    test("returns bot token string for Slack when Socket Mode credentials exist", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-conn-token" : null,
      );

      const result = await getProviderConnection(slackProvider);
      expect(result).toBe("xoxb-conn-token");
    });

    test("returns OAuthConnection for Slack when only OAuth credentials exist (backwards compat)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      const oauthConn = {
        accessToken: "xoxp-oauth-token",
      } as OAuthConnection;
      resolveOAuthConnectionMock.mockImplementation(async () => oauthConn);

      const result = await getProviderConnection(slackProvider);
      expect(result).toBe(oauthConn);
    });

    test("throws when no Slack credentials exist", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      resolveOAuthConnectionMock.mockImplementation(async () => {
        throw new Error("No OAuth connection found");
      });

      await expect(getProviderConnection(slackProvider)).rejects.toThrow(
        "No OAuth connection found",
      );
    });

    test('Telegram still returns "" (no resolveConnection, uses isConnected path — regression check)', async () => {
      // Telegram has isConnected but no resolveConnection.
      // When isConnected returns true, getProviderConnection returns ""
      getSecureKeyAsyncMock.mockImplementation(async (key: string) => {
        if (key === "credential/telegram/bot_token") return "bot-token";
        if (key === "credential/telegram/webhook_secret") return "secret";
        return null;
      });
      getConnectionByProviderMock.mockImplementation((provider: string) =>
        provider === "telegram" ? { status: "active" } : undefined,
      );

      const result = await getProviderConnection(telegramBotMessagingProvider);
      expect(result).toBe("");
    });

    test("Gmail still calls resolveOAuthConnection (no resolveConnection, no isConnected — regression check)", async () => {
      // Gmail has neither resolveConnection nor isConnected.
      // getProviderConnection falls through to resolveOAuthConnection.
      const oauthConn = {
        accessToken: "gmail-oauth-token",
      } as OAuthConnection;
      resolveOAuthConnectionMock.mockImplementation(async () => oauthConn);

      const result = await getProviderConnection(gmailMessagingProvider);
      expect(result).toBe(oauthConn);
      expect(resolveOAuthConnectionMock).toHaveBeenCalledWith(
        "integration:google",
        { account: undefined },
      );
    });
  });

  // ── resolveProvider() multi-platform behavior ───────────────────────────

  describe("resolveProvider() multi-platform behavior", () => {
    test('throws "Multiple platforms connected" when both Gmail and Slack (Socket Mode) are connected and no platform is specified', async () => {
      // Slack connected via Socket Mode
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-token" : null,
      );
      // Gmail connected via OAuth
      isProviderConnectedMock.mockImplementation(async (service: string) =>
        service === "integration:google" ? true : false,
      );

      await expect(resolveProvider()).rejects.toThrow(
        "Multiple platforms connected",
      );
    });

    test("auto-selects Slack when it is the only connected provider", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-only" : null,
      );
      isProviderConnectedMock.mockImplementation(async () => false);

      const provider = await resolveProvider();
      expect(provider.id).toBe("slack");
    });

    test("auto-selects Gmail when it is the only connected provider (no Slack credentials)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      isProviderConnectedMock.mockImplementation(async (service: string) =>
        service === "integration:google" ? true : false,
      );

      const provider = await resolveProvider();
      expect(provider.id).toBe("gmail");
    });
  });

  // ── getConnectedProviders() ─────────────────────────────────────────────

  describe("getConnectedProviders()", () => {
    test("includes Slack when connected via Socket Mode (slack_channel)", async () => {
      getSecureKeyAsyncMock.mockImplementation(async (key: string) =>
        key === "credential/slack_channel/bot_token" ? "xoxb-token" : null,
      );
      isProviderConnectedMock.mockImplementation(async () => false);

      const connected = await getConnectedProviders();
      const ids = connected.map((p) => p.id);
      expect(ids).toContain("slack");
    });

    test("excludes Slack when no bot token exists", async () => {
      getSecureKeyAsyncMock.mockImplementation(async () => null);
      isProviderConnectedMock.mockImplementation(async () => false);

      const connected = await getConnectedProviders();
      const ids = connected.map((p) => p.id);
      expect(ids).not.toContain("slack");
    });
  });
});
