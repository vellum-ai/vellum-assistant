import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Use encrypted backend with a temp store path
// ---------------------------------------------------------------------------

import { _setStorePath } from "../security/encrypted-store.js";
import { _resetBackend } from "../security/secure-keys.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-credvault-unit-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock registry to avoid double-registration
// ---------------------------------------------------------------------------

mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Mock oauth-store to avoid SQLite dependency in unit tests
// ---------------------------------------------------------------------------

let mockGetMostRecentAppByProvider: ReturnType<
  typeof mock<(key: string) => unknown>
>;
let mockGetAppByProviderAndClientId: ReturnType<
  typeof mock<(key: string, clientId: string) => unknown>
>;
let mockGetProvider: ReturnType<typeof mock<(key: string) => unknown>>;

mock.module("../oauth/oauth-store.js", () => {
  mockGetMostRecentAppByProvider = mock(() => undefined);
  mockGetAppByProviderAndClientId = mock(() => undefined);
  mockGetProvider = mock(() => undefined);
  return {
    getMostRecentAppByProvider: mockGetMostRecentAppByProvider,
    getAppByProviderAndClientId: mockGetAppByProviderAndClientId,
    getProvider: mockGetProvider,
    listConnections: mock(() => []),
    seedProviders: mock(() => {}),
    disconnectOAuthProvider: mock(async () => "not-found" as const),
  };
});

let manualConnectionStore: Record<string, string> = {};
let slackChannelConfigCalls: Array<{
  botToken?: string;
  appToken?: string;
}> = [];
let telegramConfigCalls: string[] = [];

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: async (providerKey: string) => {
    const { credentialKey } = await import("../security/credential-key.js");
    const { getSecureKeyAsync } = await import("../security/secure-keys.js");

    if (providerKey === "slack_channel") {
      const hasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const hasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      if (hasBotToken && hasAppToken) {
        manualConnectionStore[providerKey] = "active";
      } else {
        delete manualConnectionStore[providerKey];
      }
    }
  },
}));

mock.module("../daemon/handlers/config-slack-channel.js", () => ({
  setSlackChannelConfig: async (botToken?: string, appToken?: string) => {
    slackChannelConfigCalls.push({ botToken, appToken });

    const { credentialKey } = await import("../security/credential-key.js");
    const { getSecureKeyAsync, setSecureKeyAsync } =
      await import("../security/secure-keys.js");
    const { upsertCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");

    const hasExistingBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasExistingAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));

    if (appToken && !appToken.startsWith("xapp-")) {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasAppToken: hasExistingAppToken,
        connected: hasExistingBotToken && hasExistingAppToken,
        error: 'Invalid app token: must start with "xapp-"',
      };
    }

    if (botToken === "xoxb-invalid-token") {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasAppToken: hasExistingAppToken,
        connected: hasExistingBotToken && hasExistingAppToken,
        error: "Slack API validation failed: invalid_auth",
      };
    }

    if (botToken) {
      await setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        botToken,
      );
      upsertCredentialMetadata("slack_channel", "bot_token", {});
    }
    if (appToken) {
      await setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        appToken,
      );
      upsertCredentialMetadata("slack_channel", "app_token", {});
    }

    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));

    if (hasBotToken && hasAppToken) {
      manualConnectionStore["slack_channel"] = "active";
    } else {
      delete manualConnectionStore["slack_channel"];
    }

    const warning =
      hasBotToken && !hasAppToken
        ? "Bot token stored but app token is missing - connection incomplete."
        : !hasBotToken && hasAppToken
          ? "App token stored but bot token is missing - connection incomplete."
          : undefined;

    return {
      success: true,
      hasBotToken,
      hasAppToken,
      connected: hasBotToken && hasAppToken,
      teamName: hasBotToken ? "Test Team" : undefined,
      botUsername: hasBotToken ? "testbot" : undefined,
      warning,
    };
  },
}));

mock.module("../daemon/handlers/config-telegram.js", () => ({
  setTelegramConfig: async (botToken?: string) => {
    if (botToken) {
      telegramConfigCalls.push(botToken);
    }

    const { credentialKey } = await import("../security/credential-key.js");
    const { getSecureKeyAsync, setSecureKeyAsync } =
      await import("../security/secure-keys.js");
    const { upsertCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");

    const hasExistingBotToken = !!(await getSecureKeyAsync(
      credentialKey("telegram", "bot_token"),
    ));
    const hasExistingWebhookSecret = !!(await getSecureKeyAsync(
      credentialKey("telegram", "webhook_secret"),
    ));

    if (botToken === "123:invalid-token") {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasWebhookSecret: hasExistingWebhookSecret,
        connected: hasExistingBotToken && hasExistingWebhookSecret,
        error:
          'Telegram API validation failed: {"ok":false,"error_code":404,"description":"Not Found"}',
      };
    }

    if (botToken) {
      await setSecureKeyAsync(credentialKey("telegram", "bot_token"), botToken);
      upsertCredentialMetadata("telegram", "bot_token", {});
    }

    await setSecureKeyAsync(
      credentialKey("telegram", "webhook_secret"),
      "generated-webhook-secret",
    );
    upsertCredentialMetadata("telegram", "webhook_secret", {});
    manualConnectionStore["telegram"] = "active";

    return {
      success: true,
      hasBotToken: true,
      hasWebhookSecret: true,
      connected: true,
      botId: "123456",
      botUsername: "testbot",
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock public ingress URL — not available in unit tests. The connect
// orchestrator dynamically imports this for non-interactive flows.
// ---------------------------------------------------------------------------

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => {
    throw new Error("No public ingress URL configured");
  },
}));

// ---------------------------------------------------------------------------
// Mock prepareOAuth2Flow — unit tests should not start real loopback HTTP
// servers. The connect orchestrator still runs its own validation logic
// (scope policy, non-interactive ingress checks, etc.) but the actual
// OAuth flow setup is stubbed.
// ---------------------------------------------------------------------------

mock.module("../security/oauth2.js", () => ({
  prepareOAuth2Flow: mock(async () => ({
    authUrl: "https://mock-auth-url.example.com/authorize",
    state: "mock-state",
    completion: new Promise(() => {}),
  })),
  startOAuth2Flow: mock(async () => ({
    grantedScopes: [],
    tokens: { access_token: "mock-token" },
  })),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { credentialKey } from "../security/credential-key.js";
import {
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { CredentialBroker } from "../tools/credentials/broker.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { credentialStoreTool } from "../tools/credentials/vault.js";
import type { ToolContext } from "../tools/types.js";

const _ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv",
  trustClass: "guardian",
};

beforeEach(() => {
  manualConnectionStore = {};
  slackChannelConfigCalls = [];
  telegramConfigCalls = [];
});

afterAll(() => {
  mock.restore();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Broker — Transient (one-time) credential injection and consumption
// ---------------------------------------------------------------------------

describe("CredentialBroker transient credentials", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("consume returns transient value and deletes it", () => {
    upsertCredentialMetadata("svc", "key", { allowedTools: ["tool1"] });
    broker.injectTransient("svc", "key", "one-time-secret");

    const auth = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "tool1",
    });
    expect(auth.authorized).toBe(true);
    if (!auth.authorized) return;

    const result = broker.consume(auth.token.tokenId);
    expect(result.success).toBe(true);
    expect(result.value).toBe("one-time-secret");
    expect(result.storageKey).toBe(credentialKey("svc", "key"));

    // Second authorize + consume should NOT have the transient value
    const auth2 = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "tool1",
    });
    expect(auth2.authorized).toBe(true);
    if (!auth2.authorized) return;
    const result2 = broker.consume(auth2.token.tokenId);
    expect(result2.success).toBe(true);
    // No transient value — falls back to storage key only
    expect(result2.value).toBeUndefined();
  });

  test("browserFill uses transient value when available", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    broker.injectTransient("github", "token", "transient-ghp-123");

    let filledValue: string | undefined;
    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filledValue = v;
      },
    });

    expect(result.success).toBe(true);
    expect(filledValue).toBe("transient-ghp-123");
  });

  test("browserFill consumes transient value — second fill falls back to stored", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "stored-value");
    broker.injectTransient("github", "token", "transient-value");

    // First fill uses transient
    let filled1: string | undefined;
    await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled1 = v;
      },
    });
    expect(filled1).toBe("transient-value");

    // Second fill falls back to stored value
    let filled2: string | undefined;
    await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled2 = v;
      },
    });
    expect(filled2).toBe("stored-value");
  });

  test("browserFill preserves transient value on fill failure", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    broker.injectTransient("github", "token", "transient-preserved");

    // First fill fails
    const result1 = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("Playwright timeout");
      },
    });
    expect(result1.success).toBe(false);

    // Second fill should still have the transient value
    let filled: string | undefined;
    const result2 = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled = v;
      },
    });
    expect(result2.success).toBe(true);
    expect(filled).toBe("transient-preserved");
  });

  test("serverUse uses transient value when available", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["deploy"],
    });
    broker.injectTransient("vercel", "api_token", "transient-vercel-tok");

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "deploy",
      execute: async (v) => {
        expect(v).toBe("transient-vercel-tok");
        return "deployed";
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe("deployed");
  });

  test("serverUse consumes transient — subsequent call has no value without stored key", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["deploy"],
    });
    // Only transient, no stored value
    broker.injectTransient("vercel", "api_token", "transient-only");

    await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "deploy",
      execute: async () => "ok",
    });

    // Second call: no transient, no stored value
    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "deploy",
      execute: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("no stored value");
  });

  test("injectTransient replaces previous transient for same key", () => {
    upsertCredentialMetadata("svc", "key", { allowedTools: ["t"] });
    broker.injectTransient("svc", "key", "first");
    broker.injectTransient("svc", "key", "second");

    const auth = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "t",
    });
    if (!auth.authorized) return;
    const result = broker.consume(auth.token.tokenId);
    expect(result.value).toBe("second");
  });

  test("transient value for one credential does not affect another", () => {
    upsertCredentialMetadata("svcA", "key", { allowedTools: ["t"] });
    upsertCredentialMetadata("svcB", "key", { allowedTools: ["t"] });
    broker.injectTransient("svcA", "key", "val-a");

    // svcB should not have a transient value — consume returns storageKey only
    const authB = broker.authorize({
      service: "svcB",
      field: "key",
      toolName: "t",
    });
    if (!authB.authorized) return;
    const resultB = broker.consume(authB.token.tokenId);
    expect(resultB.success).toBe(true);
    expect(resultB.value).toBeUndefined();

    // svcA should have the transient
    const authA = broker.authorize({
      service: "svcA",
      field: "key",
      toolName: "t",
    });
    if (!authA.authorized) return;
    const resultA = broker.consume(authA.token.tokenId);
    expect(resultA.value).toBe("val-a");
  });
});

// ---------------------------------------------------------------------------
// 2. Vault — unknown action handling
// ---------------------------------------------------------------------------

describe("credential_store tool — unknown action", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("returns error for unknown action", async () => {
    const result = await credentialStoreTool.execute(
      { action: "unknown_action" },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown action");
    expect(result.content).toContain("unknown_action");
  });
});

// ---------------------------------------------------------------------------
// 3. Vault — prompt action edge cases
// ---------------------------------------------------------------------------

describe("credential_store tool — prompt action", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("returns error when requestSecret is not available", async () => {
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "API Key" },
      _ctx, // no requestSecret
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  test("returns error when service is missing for prompt", async () => {
    const result = await credentialStoreTool.execute(
      { action: "prompt", field: "key" },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("service is required");
  });

  test("returns error when field is missing for prompt", async () => {
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc" },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("field is required");
  });

  test("handles user cancellation (null value)", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: null as unknown as string,
        delivery: "store" as const,
      }),
    };
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Test" },
      ctxWithPrompt,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("cancelled");
  });

  test("stores credential when user provides value via prompt", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "prompt-secret-val",
        delivery: "store" as const,
      }),
    };
    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "test-prompt",
        field: "api_key",
        label: "API Key",
      },
      ctxWithPrompt,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("test-prompt/api_key");
    expect(result.content).not.toContain("prompt-secret-val");

    // Verify stored
    expect(
      await getSecureKeyAsync(credentialKey("test-prompt", "api_key")),
    ).toBe("prompt-secret-val");
  });

  test("prompt with policy fields persists metadata", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "prompt-val",
        delivery: "store" as const,
      }),
    };
    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "github",
        field: "token",
        label: "GitHub Token",
        allowed_tools: ["browser_fill_credential"],
        allowed_domains: ["github.com"],
        usage_description: "GitHub login",
      },
      ctxWithPrompt,
    );
    expect(result.isError).toBe(false);

    const { getCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");
    const meta = getCredentialMetadata("github", "token");
    expect(meta).toBeDefined();
    expect(meta!.allowedTools).toEqual(["browser_fill_credential"]);
    expect(meta!.allowedDomains).toEqual(["github.com"]);
    expect(meta!.usageDescription).toBe("GitHub login");
  });

  test("chat-style slack_channel prompts create the manual connection once both tokens exist", async () => {
    const promptValues = ["xapp-test-token", "xoxb-test-token"];
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: promptValues.shift() ?? "",
        delivery: "store" as const,
      }),
    };

    const appResult = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "app_token",
        label: "App-Level Token",
      },
      ctxWithPrompt,
    );
    expect(appResult.isError).toBe(false);
    expect(manualConnectionStore["slack_channel"]).toBeUndefined();
    expect(slackChannelConfigCalls).toEqual([{ appToken: "xapp-test-token" }]);
    expect(appResult.content).toContain("connection incomplete");

    const botResult = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "bot_token",
        label: "Bot User OAuth Token",
      },
      ctxWithPrompt,
    );
    expect(botResult.isError).toBe(false);
    expect(manualConnectionStore["slack_channel"]).toBe("active");
    expect(slackChannelConfigCalls).toEqual([
      { appToken: "xapp-test-token" },
      { botToken: "xoxb-test-token" },
    ]);
    expect(botResult.content).toContain(
      "Slack channel connected to Test Team (@testbot).",
    );
  });

  test("slack_channel prompt rejects transient send delivery", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "xapp-test-token",
        delivery: "transient_send" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "app_token",
        label: "App-Level Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be saved to secure storage");
    expect(slackChannelConfigCalls).toEqual([]);
  });

  test("slack_channel bot token prompt fails through the settings handler", async () => {
    const promptValues = ["xapp-test-token", "xoxb-invalid-token"];
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: promptValues.shift() ?? "",
        delivery: "store" as const,
      }),
    };

    const appResult = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "app_token",
        label: "App-Level Token",
      },
      ctxWithPrompt,
    );
    expect(appResult.isError).toBe(false);

    const botResult = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "bot_token",
        label: "Bot User OAuth Token",
      },
      ctxWithPrompt,
    );

    expect(botResult.isError).toBe(true);
    expect(botResult.content).toContain("invalid_auth");
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "bot_token")),
    ).toBeUndefined();
  });

  test("telegram bot token prompt runs through the Telegram config handler", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "123456:telegram-valid-token",
        delivery: "store" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "telegram",
        field: "bot_token",
        label: "Telegram Bot Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(false);
    expect(telegramConfigCalls).toEqual(["123456:telegram-valid-token"]);
    expect(manualConnectionStore["telegram"]).toBe("active");
    expect(result.content).toContain("Telegram connected as @testbot.");
    expect(result.content).not.toContain("Registered commands");
    expect(
      await getSecureKeyAsync(credentialKey("telegram", "bot_token")),
    ).toBe("123456:telegram-valid-token");
    expect(
      await getSecureKeyAsync(credentialKey("telegram", "webhook_secret")),
    ).toBe("generated-webhook-secret");
  });

  test("telegram bot token prompt rejects transient send delivery", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "123456:telegram-valid-token",
        delivery: "transient_send" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "telegram",
        field: "bot_token",
        label: "Telegram Bot Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Telegram bot credentials must be saved to secure storage",
    );
    expect(telegramConfigCalls).toEqual([]);
  });

  test("telegram bot token prompt surfaces config handler validation errors", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "123:invalid-token",
        delivery: "store" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "telegram",
        field: "bot_token",
        label: "Telegram Bot Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Telegram API validation failed");
    expect(
      await getSecureKeyAsync(credentialKey("telegram", "bot_token")),
    ).toBeUndefined();
  });

  test("prompt rejects invalid policy input", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({ value: "val", delivery: "store" as const }),
    };
    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "svc",
        field: "key",
        label: "Test",
        allowed_tools: "not-an-array",
      },
      ctxWithPrompt,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("allowed_tools must be an array");
  });
});

// ---------------------------------------------------------------------------
// 4. Vault — oauth2_connect error paths
// ---------------------------------------------------------------------------

describe("credential_store tool — oauth2_connect error paths", () => {
  /** Well-known provider rows returned by the mocked getProvider */
  const wellKnownProviders: Record<string, object> = {
    "integration:google": {
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
      scopePolicy: JSON.stringify({}),
      callbackTransport: "loopback",
      loopbackPort: 8756,
    },
    "integration:slack": {
      key: "integration:slack",
      authUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      defaultScopes: JSON.stringify(["channels:read"]),
      scopePolicy: JSON.stringify({}),
    },
  };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    // Return well-known provider rows so vault.ts knows gmail/slack are
    // registered, and custom providers return undefined.
    mockGetProvider.mockImplementation(
      (key: string) => wellKnownProviders[key] ?? undefined,
    );
    mockGetMostRecentAppByProvider.mockClear();
    mockGetMostRecentAppByProvider.mockImplementation(() => undefined);
    mockGetAppByProviderAndClientId.mockClear();
    mockGetAppByProviderAndClientId.mockImplementation(() => undefined);
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    mockGetProvider.mockImplementation(() => undefined);
    mockGetMostRecentAppByProvider.mockImplementation(() => undefined);
    mockGetAppByProviderAndClientId.mockImplementation(() => undefined);
  });

  test("requires service parameter", async () => {
    const result = await credentialStoreTool.execute(
      { action: "oauth2_connect" },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("service is required");
  });

  test("rejects unknown service without registered provider", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "custom-svc",
        auth_url: "https://a",
        token_url: "https://t",
        scopes: ["read"],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no OAuth provider registered");
  });

  test("requires client_id", async () => {
    mockGetProvider.mockImplementation((key: string) => {
      if (key === "custom-svc") {
        return {
          key: "custom-svc",
          authUrl: "https://auth.example.com",
          tokenUrl: "https://token.example.com",
          defaultScopes: JSON.stringify(["read"]),
          scopePolicy: JSON.stringify({}),
        };
      }
      return wellKnownProviders[key] ?? undefined;
    });
    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "custom-svc",
        scopes: ["read"],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("client_id is required");
  });

  test("non-interactive loopback oauth2_connect returns deferred auth URL", async () => {
    // After the blanket non-interactive guard was removed (#16337),
    // loopback-transport flows succeed with a deferred auth URL so the
    // agent can present it to the user.
    mockGetProvider.mockImplementation((key: string) => {
      if (key === "custom-svc") {
        return {
          key: "custom-svc",
          authUrl: "https://auth.example.com",
          tokenUrl: "https://token.example.com",
          defaultScopes: JSON.stringify(["read"]),
          scopePolicy: JSON.stringify({}),
        };
      }
      return wellKnownProviders[key] ?? undefined;
    });

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "custom-svc",
        auth_url: "https://auth.example.com",
        token_url: "https://token.example.com",
        scopes: ["read"],
        client_id: "test-client-id",
      },
      { ..._ctx, isInteractive: false },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("mock-auth-url.example.com");
  });

  test("resolves gmail alias to integration:google", async () => {
    // Even with alias resolution, missing client_id should still fail
    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    // Should NOT require auth_url/token_url/scopes — those are well-known for gmail
    // Should fail on client_id since none is stored
    expect(result.content).toContain("client_id is required");
  });

  test("resolves slack alias to integration:slack", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "slack",
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("client_id is required");
  });

  test("uses stored client_id from oauth-store DB", async () => {
    // Mock getMostRecentAppByProvider to return an app with a client_id
    // and store client_secret in the secure store.
    mockGetMostRecentAppByProvider.mockImplementation(() => ({
      id: "test-app-id",
      providerKey: "integration:google",
      clientId: "stored-client-id-123",
      clientSecretCredentialPath: "oauth_app/test-app-id/client_secret",
      createdAt: Date.now(),
    }));
    mockGetProvider.mockImplementation(() => ({
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
      scopePolicy: JSON.stringify({}),
      callbackTransport: "loopback",
      loopbackPort: 8756,
    }));
    await setSecureKeyAsync(
      "oauth_app/test-app-id/client_secret",
      "test-secret",
    );

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
      },
      { ..._ctx, isInteractive: false },
    );

    // Should pass client_id and client_secret checks — the flow proceeds
    // through the channel path (gmail uses loopback transport so no
    // public ingress URL is needed) and returns the authorization URL.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("To connect gmail, open this link");
    expect(result.content).not.toContain("client_id is required");
    expect(result.content).not.toContain("client_secret is required");

    // Reset mocks
    mockGetMostRecentAppByProvider.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => undefined);
  });

  test("uses getAppByProviderAndClientId when client_id is provided without client_secret", async () => {
    // When client_id is supplied but client_secret is not, the vault should
    // look up the matching app via getAppByProviderAndClientId (not the
    // most-recent-app heuristic) so the secret comes from the correct app.
    mockGetAppByProviderAndClientId.mockImplementation(
      (providerKey: string, cId: string) => {
        if (
          providerKey === "integration:google" &&
          cId === "caller-supplied-client-id"
        ) {
          return {
            id: "matched-app-id",
            providerKey: "integration:google",
            clientId: "caller-supplied-client-id",
            clientSecretCredentialPath:
              "oauth_app/matched-app-id/client_secret",
            createdAt: Date.now(),
          };
        }
        return undefined;
      },
    );
    mockGetProvider.mockImplementation(() => ({
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
      scopePolicy: JSON.stringify({}),
      callbackTransport: "loopback",
      loopbackPort: 8756,
    }));
    await setSecureKeyAsync(
      "oauth_app/matched-app-id/client_secret",
      "matched-secret",
    );

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
        client_id: "caller-supplied-client-id",
      },
      { ..._ctx, isInteractive: false },
    );

    // Should succeed — client_secret resolved from the matched app
    expect(result.isError).toBe(false);
    expect(result.content).toContain("To connect gmail, open this link");
    // getMostRecentAppByProvider should NOT have been called since client_id was known
    expect(mockGetMostRecentAppByProvider).not.toHaveBeenCalled();

    // Reset mocks
    mockGetAppByProviderAndClientId.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => undefined);
  });

  test("falls back to getMostRecentAppByProvider when client_id is not provided", async () => {
    // When neither client_id nor client_secret is provided, the vault should
    // use getMostRecentAppByProvider (the fallback heuristic).
    mockGetMostRecentAppByProvider.mockImplementation(() => ({
      id: "recent-app-id",
      providerKey: "integration:google",
      clientId: "recent-client-id",
      clientSecretCredentialPath: "oauth_app/recent-app-id/client_secret",
      createdAt: Date.now(),
    }));
    mockGetProvider.mockImplementation(() => ({
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
      scopePolicy: JSON.stringify({}),
      callbackTransport: "loopback",
      loopbackPort: 8756,
    }));
    await setSecureKeyAsync(
      "oauth_app/recent-app-id/client_secret",
      "recent-secret",
    );

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
      },
      { ..._ctx, isInteractive: false },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("To connect gmail, open this link");
    // getAppByProviderAndClientId should NOT have been called since client_id was unknown
    expect(mockGetAppByProviderAndClientId).not.toHaveBeenCalled();

    // Reset mocks
    mockGetMostRecentAppByProvider.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => undefined);
  });

  test("getAppByProviderAndClientId returning undefined leaves client_secret unresolved", async () => {
    // When client_id is provided but getAppByProviderAndClientId returns no
    // matching app, client_secret remains unresolved and the vault should
    // report the missing secret error.
    mockGetAppByProviderAndClientId.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => ({
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
    }));

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
        client_id: "unknown-client-id",
      },
      _ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("client_secret is required for gmail");
    // getMostRecentAppByProvider should NOT have been called
    expect(mockGetMostRecentAppByProvider).not.toHaveBeenCalled();

    // Reset mocks
    mockGetAppByProviderAndClientId.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => undefined);
  });

  test("rejects when client_secret is missing for service that requires it", async () => {
    // Mock getMostRecentAppByProvider to return an app with client_id but
    // no client_secret in secure storage — validates the requiresClientSecret
    // guardrail.
    mockGetMostRecentAppByProvider.mockImplementation(() => ({
      id: "test-app-id-no-secret",
      providerKey: "integration:google",
      clientId: "stored-client-id-456",
      createdAt: Date.now(),
    }));
    mockGetProvider.mockImplementation(() => ({
      key: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: JSON.stringify(["https://mail.google.com/"]),
    }));

    const result = await credentialStoreTool.execute(
      {
        action: "oauth2_connect",
        service: "gmail",
      },
      _ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("client_secret is required for gmail");

    // Reset mocks
    mockGetMostRecentAppByProvider.mockImplementation(() => undefined);
    mockGetProvider.mockImplementation(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// 5. Vault — store action validation edge cases
// ---------------------------------------------------------------------------

describe("credential_store tool — store validation edge cases", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("rejects alias that is not a string", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        alias: 42,
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("alias must be a string");
  });

  test("rejects injection_templates that is not an array", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        injection_templates: "not-an-array",
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("injection_templates must be an array");
  });

  test("rejects template with invalid injectionType", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        injection_templates: [
          { hostPattern: "*.example.com", injectionType: "cookie" },
        ],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "injectionType must be 'header' or 'query'",
    );
  });

  test("rejects template with empty hostPattern", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        injection_templates: [
          {
            hostPattern: "  ",
            injectionType: "header",
            headerName: "Authorization",
          },
        ],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("hostPattern must be a non-empty string");
  });

  test("rejects template with non-string valuePrefix", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        injection_templates: [
          {
            hostPattern: "*.example.com",
            injectionType: "header",
            headerName: "Auth",
            valuePrefix: 42,
          },
        ],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("valuePrefix must be a string");
  });

  test("reports multiple template errors at once", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "svc",
        field: "key",
        value: "val",
        injection_templates: [
          { hostPattern: "", injectionType: "header", headerName: "X-Key" },
          { hostPattern: "*.example.com", injectionType: "query" }, // missing queryParamName
        ],
      },
      _ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("hostPattern");
    expect(result.content).toContain("queryParamName");
  });

  test("delete removes both secret and metadata", async () => {
    await credentialStoreTool.execute(
      {
        action: "store",
        service: "del-test",
        field: "key",
        value: "secret",
      },
      _ctx,
    );

    // Verify stored
    expect(await getSecureKeyAsync(credentialKey("del-test", "key"))).toBe(
      "secret",
    );
    const { getCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");
    expect(getCredentialMetadata("del-test", "key")).toBeDefined();

    // Delete
    const result = await credentialStoreTool.execute(
      {
        action: "delete",
        service: "del-test",
        field: "key",
      },
      _ctx,
    );
    expect(result.isError).toBe(false);

    // Both should be gone
    expect(
      await getSecureKeyAsync(credentialKey("del-test", "key")),
    ).toBeUndefined();
    expect(getCredentialMetadata("del-test", "key")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Vault — tool definition schema
// ---------------------------------------------------------------------------

describe("credential_store tool — tool definition", () => {
  test("tool name and category are correct", () => {
    expect(credentialStoreTool.name).toBe("credential_store");
    expect(credentialStoreTool.category).toBe("credentials");
  });

  test("getDefinition returns valid schema with required action", () => {
    const def = credentialStoreTool.getDefinition();
    expect(def.name).toBe("credential_store");
    const schema = def.input_schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.action.enum).toEqual([
      "store",
      "list",
      "delete",
      "prompt",
      "oauth2_connect",
      "describe",
    ]);
  });

  test("getDefinition includes injection_templates schema", () => {
    const def = credentialStoreTool.getDefinition();
    const schemaProps = (def.input_schema as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    const templates = schemaProps.injection_templates as Record<
      string,
      unknown
    >;
    expect(templates).toBeDefined();
    expect(templates.type).toBe("array");
    const items = (templates.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(items.hostPattern).toBeDefined();
    expect(items.injectionType.enum).toEqual(["header", "query"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Broker — serverUseById with transient not supported
//    (transient is scoped to authorize+consume and browserFill/serverUse)
// ---------------------------------------------------------------------------

describe("CredentialBroker — serverUseById edge cases", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("serverUseById with multiple injection templates returns all", async () => {
    const meta = upsertCredentialMetadata("multi", "api_key", {
      allowedTools: ["proxy"],
      injectionTemplates: [
        {
          hostPattern: "*.fal.ai",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Key ",
        },
        {
          hostPattern: "gateway.fal.ai",
          injectionType: "header",
          headerName: "X-Fal-Key",
        },
      ],
    });
    await setSecureKeyAsync(credentialKey("multi", "api_key"), "multi-secret");

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "proxy",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.injectionTemplates).toHaveLength(2);
    expect(result.injectionTemplates[0].hostPattern).toBe("*.fal.ai");
    expect(result.injectionTemplates[1].hostPattern).toBe("gateway.fal.ai");
    // No secret value in result
    expect(JSON.stringify(result)).not.toContain("multi-secret");
  });

  test("serverUseById verifies secret exists in storage (fail-closed)", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key", {
      allowedTools: ["proxy"],
    });
    // No setSecureKeyAsync — metadata exists but value doesn't

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "proxy",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toContain("no stored value");
  });
});

// ---------------------------------------------------------------------------
// 8. Broker — revokeAll clears transient values indirectly via token cleanup
// ---------------------------------------------------------------------------

describe("CredentialBroker — revokeAll", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  test("revokeAll clears all tokens and subsequent consume fails", () => {
    upsertCredentialMetadata("svc", "key", { allowedTools: ["t1", "t2"] });
    const a1 = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "t1",
    });
    const a2 = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "t2",
    });
    expect(broker.activeTokenCount).toBe(2);

    broker.revokeAll();
    expect(broker.activeTokenCount).toBe(0);

    if (a1.authorized) {
      const r = broker.consume(a1.token.tokenId);
      expect(r.success).toBe(false);
    }
    if (a2.authorized) {
      const r = broker.consume(a2.token.tokenId);
      expect(r.success).toBe(false);
    }
  });

  test("revokeAll on empty broker is a no-op", () => {
    expect(broker.activeTokenCount).toBe(0);
    broker.revokeAll();
    expect(broker.activeTokenCount).toBe(0);
  });
});
