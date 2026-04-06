import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { createTestHandlerContext } from "./handlers/handler-test-helpers.js";

// ── Mock state ──────────────────────────────────────────────────────────────

let secureKeyStore: Record<string, string> = {};
let savedConfig: Record<string, unknown> = {};
let oauthConnectionStore: Record<
  string,
  { id: string; status: string; accountInfo?: string | null }
> = {};
const mockShouldUsePlatformCallbacks = mock(() => false);
const mockRegisterCallbackRoute = mock(
  () => Promise.resolve() as Promise<void>,
);

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ telegram: {}, ui: {} }),
  loadRawConfig: () => structuredClone(savedConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedConfig = structuredClone(raw);
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    const keys = path.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] == null || typeof current[keys[i]] !== "object") {
        current[keys[i]] = {};
      }
      current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
  },
}));

mock.module("../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: mockRegisterCallbackRoute,
  shouldUsePlatformCallbacks: mockShouldUsePlatformCallbacks,
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
  ensureManualTokenConnection: async (
    providerKey: string,
    accountInfo?: string,
  ) => {
    oauthConnectionStore[providerKey] = {
      id: `conn-${providerKey}`,
      status: "active",
      accountInfo: accountInfo ?? null,
    };
  },
  removeManualTokenConnection: (providerKey: string) => {
    delete oauthConnectionStore[providerKey];
  },
  syncManualTokenConnection: async () => {},
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

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  clearTelegramConfig,
  handleTelegramConfig,
  setTelegramCommands,
  setTelegramConfig,
  setupTelegram,
  summarizeTelegramError,
} from "../daemon/handlers/config-telegram.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockTelegramGetMe(
  ok: boolean,
  result?: { id?: number; username?: string },
) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

function mockTelegramApi(responses: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("summarizeTelegramError", () => {
  test("formats Error with message", () => {
    const result = summarizeTelegramError(new Error("Connection refused"));
    expect(result).toContain("Connection refused");
  });

  test("includes path and code when present", () => {
    const err = Object.assign(new Error("fail"), {
      path: "/api/foo",
      code: "ECONNREFUSED",
    });
    const result = summarizeTelegramError(err);
    expect(result).toContain("path=/api/foo");
    expect(result).toContain("code=ECONNREFUSED");
  });

  test("redacts bot tokens in error messages", () => {
    const result = summarizeTelegramError(
      new Error(
        "Error at /bot1234567890:ABCDefghijklmnopqrstuvwxyz0123456789/getMe",
      ),
    );
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ABCDefghijklmnopqrstuvwxyz0123456789");
  });

  test("handles non-Error values", () => {
    const result = summarizeTelegramError("string error");
    expect(result).toBe("string error");
  });
});

describe("setTelegramConfig", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    savedConfig = {};
    globalThis.fetch = originalFetch;
    mockShouldUsePlatformCallbacks.mockReturnValue(false);
    mockRegisterCallbackRoute.mockReset();
    mockRegisterCallbackRoute.mockReturnValue(Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("valid token: calls getMe, stores token + webhook secret, returns connected", async () => {
    mockTelegramGetMe(true, { id: 999, username: "mybot" });

    const result = await setTelegramConfig("999:valid-token-abcdefg");

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.botUsername).toBe("mybot");
    expect(result.botId).toBe("999");
    expect(result.connected).toBe(true);
    expect(result.hasWebhookSecret).toBe(true);
    // Token stored in secure keys
    expect(secureKeyStore[credentialKey("telegram", "bot_token")]).toBe(
      "999:valid-token-abcdefg",
    );
    // Webhook secret auto-generated
    expect(
      secureKeyStore[credentialKey("telegram", "webhook_secret")],
    ).toBeTruthy();
  });

  test("invalid token (getMe returns ok:false) → failure", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await setTelegramConfig("bad-token");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Telegram API");
  });

  test("getMe HTTP error → failure", async () => {
    globalThis.fetch = (async () =>
      new Response("Unauthorized", {
        status: 401,
      })) as unknown as typeof globalThis.fetch;

    const result = await setTelegramConfig("bad-token");

    expect(result.success).toBe(false);
  });

  test("network error → failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const result = await setTelegramConfig("any-token");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to validate bot token");
  });

  test("no botToken arg → uses existing token from storage", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] =
      "111:stored-token-xyz";
    mockTelegramGetMe(true, { id: 111, username: "storedbot" });

    const result = await setTelegramConfig();

    expect(result.success).toBe(true);
    expect(result.botUsername).toBe("storedbot");
  });

  test("no botToken and nothing in storage → error", async () => {
    const result = await setTelegramConfig();

    expect(result.success).toBe(false);
    expect(result.error).toContain("botToken is required");
  });

  test("platform callback registration when containerized", async () => {
    mockShouldUsePlatformCallbacks.mockReturnValue(true);
    mockRegisterCallbackRoute.mockReset();
    mockRegisterCallbackRoute.mockReturnValue(Promise.resolve());
    mockTelegramGetMe(true, { id: 999, username: "mybot" });

    await setTelegramConfig("999:valid-token-abcdefg");

    expect(mockRegisterCallbackRoute).toHaveBeenCalledWith(
      "webhooks/telegram",
      "telegram",
    );
  });
});

describe("clearTelegramConfig", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    savedConfig = {};
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("token exists: calls deleteWebhook, deletes credentials, clears config", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    secureKeyStore[credentialKey("telegram", "webhook_secret")] = "secret";
    oauthConnectionStore["telegram"] = { id: "conn-1", status: "active" };

    mockTelegramApi({ deleteWebhook: { ok: true } });

    const result = await clearTelegramConfig();

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.hasWebhookSecret).toBe(false);
    expect(
      secureKeyStore[credentialKey("telegram", "bot_token")],
    ).toBeUndefined();
    expect(
      secureKeyStore[credentialKey("telegram", "webhook_secret")],
    ).toBeUndefined();
  });

  test("deleteWebhook failure → proceeds with cleanup", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    secureKeyStore[credentialKey("telegram", "webhook_secret")] = "secret";

    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof globalThis.fetch;

    const result = await clearTelegramConfig();

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
  });

  test("no token stored → succeeds without API call", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await clearTelegramConfig();

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    // Should not have called Telegram API
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("setTelegramCommands", () => {
  beforeEach(() => {
    secureKeyStore = {};
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("valid commands → calls setMyCommands API", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    mockTelegramApi({ setMyCommands: { ok: true } });

    const result = await setTelegramCommands([
      { command: "new", description: "Start new conversation" },
    ]);

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
  });

  test("no bot token → returns error", async () => {
    const result = await setTelegramCommands();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Bot token not configured");
  });

  test("API failure → returns error", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request" }), {
        status: 400,
      })) as unknown as typeof globalThis.fetch;

    const result = await setTelegramCommands();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to set bot commands");
  });
});

describe("setupTelegram", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    savedConfig = {};
    globalThis.fetch = originalFetch;
    mockShouldUsePlatformCallbacks.mockReturnValue(false);
    mockRegisterCallbackRoute.mockReset();
    mockRegisterCallbackRoute.mockReturnValue(Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("both set + commands succeed → merged result", async () => {
    mockTelegramApi({
      getMe: { ok: true, result: { id: 999, username: "mybot" } },
      setMyCommands: { ok: true },
    });

    const result = await setupTelegram(undefined, "999:tok");

    expect(result.success).toBe(true);
    expect(result.botUsername).toBe("mybot");
    expect(result.commandsRegistered).toBeDefined();
  });

  test("set succeeds but commands fail → success with warning", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 999, username: "mybot" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // setMyCommands fails
      return new Response("Server Error", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const result = await setupTelegram(undefined, "999:tok");

    expect(result.success).toBe(true);
    expect(result.warning).toBeDefined();
  });

  test("set fails → failure immediately", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Network down");
    }) as unknown as typeof globalThis.fetch;

    const result = await setupTelegram(undefined, "bad-token");

    expect(result.success).toBe(false);
  });
});

describe("handleTelegramConfig", () => {
  beforeEach(() => {
    secureKeyStore = {};
    oauthConnectionStore = {};
    savedConfig = {};
    globalThis.fetch = originalFetch;
    mockShouldUsePlatformCallbacks.mockReturnValue(false);
    mockRegisterCallbackRoute.mockReset();
    mockRegisterCallbackRoute.mockReturnValue(Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("dispatches 'get'", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    secureKeyStore[credentialKey("telegram", "webhook_secret")] = "secret";
    oauthConnectionStore["telegram"] = { id: "c1", status: "active" };

    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig({ type: "telegram_config", action: "get" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(true);
  });

  test("dispatches 'set'", async () => {
    mockTelegramGetMe(true, { id: 999, username: "mybot" });

    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig(
      { type: "telegram_config", action: "set", botToken: "999:tok" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(true);
  });

  test("dispatches 'clear'", async () => {
    mockTelegramApi({ deleteWebhook: { ok: true } });

    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig(
      { type: "telegram_config", action: "clear" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(true);
  });

  test("dispatches 'set_commands'", async () => {
    secureKeyStore[credentialKey("telegram", "bot_token")] = "123:tok";
    mockTelegramApi({ setMyCommands: { ok: true } });

    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig(
      { type: "telegram_config", action: "set_commands" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(true);
  });

  test("dispatches 'setup'", async () => {
    mockTelegramApi({
      getMe: { ok: true, result: { id: 999, username: "mybot" } },
      setMyCommands: { ok: true },
    });

    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig(
      { type: "telegram_config", action: "setup", botToken: "999:tok" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(true);
  });

  test("unknown action → sends error", async () => {
    const { ctx, sent } = createTestHandlerContext();
    await handleTelegramConfig(
      { type: "telegram_config", action: "invalid" as any },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("telegram_config_response");
    expect(sent[0].success).toBe(false);
    expect(sent[0].error).toContain("Unknown action");
  });
});
