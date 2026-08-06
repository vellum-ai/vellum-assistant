import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../config/loader.js";
import { credentialKey } from "../security/credential-key.js";

let secureKeyStore: Record<string, string> = {};
let oauthConnectionStore: Record<
  string,
  { id: string; status: string; accountInfo?: string | null }
> = {};
const syncCalls: Array<{ provider: string; accountInfo?: string }> = [];
let platformContextEnabled = false;

const registerCallbackRouteMock = mock(
  async (callbackPath: string, _type: string) =>
    `https://gateway.vellum.ai/assistant-123/${callbackPath}`,
);

// Spread the real module: it is a shared barrel and replacing it wholesale
// breaks unrelated importers pulled in by the module under test.
const actualPlatformCallbackRegistration =
  await import("../inbound/platform-callback-registration.js");
mock.module("../inbound/platform-callback-registration.js", () => ({
  ...actualPlatformCallbackRegistration,
  registerCallbackRoute: registerCallbackRouteMock,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl: platformContextEnabled ? "https://api.vellum.ai" : "",
    assistantId: platformContextEnabled ? "assistant-123" : "",
    hasAssistantApiKey: platformContextEnabled,
    authHeader: platformContextEnabled ? "Api-Key secret" : null,
    enabled: platformContextEnabled,
  }),
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
  getConnectionByProvider: (provider: string) =>
    oauthConnectionStore[provider] ?? undefined,
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  ensureManualTokenConnection: async () => {},
  removeManualTokenConnection: () => {},
  syncManualTokenConnection: async (provider: string, accountInfo?: string) => {
    syncCalls.push({ provider, accountInfo });
    if (provider !== "telegram") {
      return;
    }
    const hasBotToken =
      !!secureKeyStore[credentialKey("telegram", "bot_token")];
    const hasWebhookSecret =
      !!secureKeyStore[credentialKey("telegram", "webhook_secret")];
    if (hasBotToken && hasWebhookSecret) {
      oauthConnectionStore[provider] = {
        id: `conn-${provider}`,
        status: "active",
        accountInfo: accountInfo ?? null,
      };
      return;
    }
    delete oauthConnectionStore[provider];
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

const { getTelegramConfig, setTelegramConfig } =
  await import("../daemon/handlers/config-telegram.js");

function mockTelegramApi(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/getMe")) {
      return new Response(
        JSON.stringify({ ok: true, result: { id: 42, username: "testbot" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

function setIngressPublicBaseUrl(url: string): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "ingress.publicBaseUrl", url);
  saveRawConfig(raw);
  invalidateConfigCache();
}

describe("Telegram config handler", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    syncCalls.length = 0;
    platformContextEnabled = false;
    registerCallbackRouteMock.mockClear();
    setIngressPublicBaseUrl("");
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
      { provider: "telegram", accountInfo: "@testbot" },
    ]);
    expect(oauthConnectionStore["telegram"]?.accountInfo).toBe("@testbot");
  });

  // A platform-connected local assistant (IS_PLATFORM unset, valid platform
  // credentials, no public ingress) receives Telegram webhooks only through
  // managed platform callbacks, so saving the bot token must register the
  // route.
  test("set registers the platform callback route for a platform-connected local assistant", async () => {
    platformContextEnabled = true;
    globalThis.fetch = mockTelegramApi();

    const result = await setTelegramConfig(
      "123456789:AAtesttoken_testtoken_testtoken_test",
    );

    expect(result.success).toBe(true);
    expect(registerCallbackRouteMock).toHaveBeenCalledWith(
      "webhooks/telegram",
      "telegram",
    );
  });

  test("set does not register a platform callback route when not platform-connected", async () => {
    globalThis.fetch = mockTelegramApi();

    const result = await setTelegramConfig(
      "123456789:AAtesttoken_testtoken_testtoken_test",
    );

    expect(result.success).toBe(true);
    expect(registerCallbackRouteMock).not.toHaveBeenCalled();
  });

  // A logged-in local assistant holds platform credentials for the LLM proxy,
  // so credential presence must not override an explicitly configured ingress.
  test("set does not register a platform callback route when a public ingress is configured", async () => {
    platformContextEnabled = true;
    setIngressPublicBaseUrl("https://abc.ngrok.io");
    globalThis.fetch = mockTelegramApi();

    const result = await setTelegramConfig(
      "123456789:AAtesttoken_testtoken_testtoken_test",
    );

    expect(result.success).toBe(true);
    expect(registerCallbackRouteMock).not.toHaveBeenCalled();
  });
});
