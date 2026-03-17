import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let secureKeyStore: Record<string, string> = {};
let oauthConnectionStore: Record<
  string,
  { id: string; status: string; accountInfo?: string | null }
> = {};
const syncCalls: Array<{ providerKey: string; accountInfo?: string }> = [];

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ telegram: {}, ui: {} }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  setNestedValue: () => {},
}));

mock.module("../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: async () => {},
  shouldUsePlatformCallbacks: () => false,
}));

mock.module("../daemon/handlers/shared.js", () => ({
  log: {
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) =>
    secureKeyStore[account] ?? undefined,
  setSecureKeyAsync: async (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKeyAsync: async (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return "deleted" as const;
    }
    return "not-found" as const;
  },
}));

mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (providerKey: string) =>
    oauthConnectionStore[providerKey] ?? undefined,
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  ensureManualTokenConnection: async () => {},
  removeManualTokenConnection: () => {},
  syncManualTokenConnection: async (
    providerKey: string,
    accountInfo?: string,
  ) => {
    syncCalls.push({ providerKey, accountInfo });
    if (providerKey !== "telegram") return;
    const hasBotToken =
      !!secureKeyStore[credentialKey("telegram", "bot_token")];
    const hasWebhookSecret =
      !!secureKeyStore[credentialKey("telegram", "webhook_secret")];
    if (hasBotToken && hasWebhookSecret) {
      oauthConnectionStore[providerKey] = {
        id: `conn-${providerKey}`,
        status: "active",
        accountInfo: accountInfo ?? null,
      };
      return;
    }
    delete oauthConnectionStore[providerKey];
  },
}));

mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotId: () => "123456",
  getTelegramBotUsername: () => "testbot",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  deleteCredentialMetadata: () => true,
  upsertCredentialMetadata: () => ({}),
}));

const originalFetch = globalThis.fetch;

import { getTelegramConfig } from "../daemon/handlers/config-telegram.js";

describe("Telegram config handler", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    syncCalls.length = 0;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET backfills telegram connection metadata with @botUsername", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:abc";
    secureKeyStore[credentialKey("telegram", "webhook_secret")] = "secret";

    const result = await getTelegramConfig();

    expect(result.success).toBe(true);
    expect(result.botUsername).toBe("testbot");
    expect(result.connected).toBe(true);
    expect(syncCalls).toEqual([
      { providerKey: "telegram", accountInfo: "@testbot" },
    ]);
    expect(oauthConnectionStore["telegram"]?.accountInfo).toBe("@testbot");
  });
});
