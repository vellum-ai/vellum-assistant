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

let disconnectOAuthProviderCalls: string[] = [];

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: mock(async (provider: string) => {
    disconnectOAuthProviderCalls.push(provider);
    return "not-found" as const;
  }),
  getActiveConnection: mock(() => undefined),
}));

let manualConnectionStore: Record<string, string> = {};
let slackChannelConfigCalls: Array<{
  botToken?: string;
  appToken?: string;
  userToken?: string;
}> = [];
let clearSlackUserTokenCalls = 0;

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: async (provider: string) => {
    const { credentialKey } = await import("../security/credential-key.js");
    const { getSecureKeyAsync } = await import("../security/secure-keys.js");

    if (provider === "slack_channel") {
      const hasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const hasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      if (hasBotToken && hasAppToken) {
        manualConnectionStore[provider] = "active";
      } else {
        delete manualConnectionStore[provider];
      }
    }
  },
}));

mock.module("../daemon/handlers/config-slack-channel.js", () => ({
  setSlackChannelConfig: async (
    botToken?: string,
    appToken?: string,
    userToken?: string,
  ) => {
    slackChannelConfigCalls.push({ botToken, appToken, userToken });

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
    const hasExistingUserToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
    ));

    if (appToken && !appToken.startsWith("xapp-")) {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasAppToken: hasExistingAppToken,
        hasUserToken: hasExistingUserToken,
        connected: hasExistingBotToken && hasExistingAppToken,
        error: 'Invalid app token: must start with "xapp-"',
      };
    }

    if (userToken && !userToken.startsWith("xoxp-")) {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasAppToken: hasExistingAppToken,
        hasUserToken: hasExistingUserToken,
        connected: hasExistingBotToken && hasExistingAppToken,
        error: 'Invalid user token: must start with "xoxp-"',
      };
    }

    if (botToken === "xoxb-invalid-token") {
      return {
        success: false,
        hasBotToken: hasExistingBotToken,
        hasAppToken: hasExistingAppToken,
        hasUserToken: hasExistingUserToken,
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
    if (userToken) {
      await setSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
        userToken,
      );
      upsertCredentialMetadata("slack_channel", "user_token", {});
    }

    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));
    const hasUserToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
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
      hasUserToken,
      connected: hasBotToken && hasAppToken,
      teamName: hasBotToken ? "Test Team" : undefined,
      botUsername: hasBotToken ? "testbot" : undefined,
      warning,
    };
  },
  clearSlackUserToken: async () => {
    clearSlackUserTokenCalls++;

    const { credentialKey } = await import("../security/credential-key.js");
    const { deleteSecureKeyAsync, getSecureKeyAsync } =
      await import("../security/secure-keys.js");
    const { deleteCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");

    await deleteSecureKeyAsync(credentialKey("slack_channel", "user_token"));
    deleteCredentialMetadata("slack_channel", "user_token");

    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));

    return {
      success: true,
      hasBotToken,
      hasAppToken,
      hasUserToken: false,
      connected:
        manualConnectionStore["slack_channel"] === "active" &&
        hasBotToken &&
        hasAppToken,
    };
  },
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
import { BROWSER_FILL_CAPABILITY } from "../tools/credentials/tool-policy.js";
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
  clearSlackUserTokenCalls = 0;
  disconnectOAuthProviderCalls = [];
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

  test("slack_channel user_token prompt routes through the settings handler", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "xoxp-valid-user-token",
        delivery: "store" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "user_token",
        label: "User OAuth Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(false);
    // Routed to handler as third positional argument.
    expect(slackChannelConfigCalls).toEqual([
      {
        botToken: undefined,
        appToken: undefined,
        userToken: "xoxp-valid-user-token",
      },
    ]);
    // Stored via the handler's mock, NOT via the generic setSecureKeyAsync path.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBe("xoxp-valid-user-token");
  });

  test("slack_channel user_token prompt surfaces handler rejection for malformed token", async () => {
    const ctxWithPrompt: ToolContext = {
      ..._ctx,
      requestSecret: async () => ({
        value: "abc-123",
        delivery: "store" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      {
        action: "prompt",
        service: "slack_channel",
        field: "user_token",
        label: "User OAuth Token",
      },
      ctxWithPrompt,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('must start with "xoxp-"');
    // Handler was called with malformed token.
    expect(slackChannelConfigCalls).toEqual([
      { botToken: undefined, appToken: undefined, userToken: "abc-123" },
    ]);
    // Value was NOT persisted.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
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
// 3b. Vault — slack_channel store routing
// ---------------------------------------------------------------------------

describe("credential_store tool — slack_channel store routing", () => {
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

  test("store with user_token routes to setSlackChannelConfig as third positional arg", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "slack_channel",
        field: "user_token",
        value: "xoxp-valid-user-token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    // Exactly one handler call with (undefined, undefined, token).
    expect(slackChannelConfigCalls).toEqual([
      {
        botToken: undefined,
        appToken: undefined,
        userToken: "xoxp-valid-user-token",
      },
    ]);
    // Stored through the handler's mock path, not the generic setSecureKeyAsync path.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBe("xoxp-valid-user-token");
  });

  test("store with user_token surfaces handler rejection for malformed token", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "slack_channel",
        field: "user_token",
        value: "abc-123",
      },
      _ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('must start with "xoxp-"');
    // Handler was called with the malformed value.
    expect(slackChannelConfigCalls).toEqual([
      { botToken: undefined, appToken: undefined, userToken: "abc-123" },
    ]);
    // Nothing was persisted.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
  });

  test("store with bot_token still routes via first positional arg", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "slack_channel",
        field: "bot_token",
        value: "xoxb-valid-bot-token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    expect(slackChannelConfigCalls).toEqual([
      {
        botToken: "xoxb-valid-bot-token",
        appToken: undefined,
        userToken: undefined,
      },
    ]);
  });

  test("store with app_token still routes via second positional arg", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "slack_channel",
        field: "app_token",
        value: "xapp-valid-app-token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    expect(slackChannelConfigCalls).toEqual([
      {
        botToken: undefined,
        appToken: "xapp-valid-app-token",
        userToken: undefined,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Vault — store action validation edge cases
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
// 4b. Vault — slack_channel delete routing
// ---------------------------------------------------------------------------

describe("credential_store tool — slack_channel delete routing", () => {
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

  test("delete with user_token leaves bot+app tokens and oauth_connection intact", async () => {
    // Seed all three Slack tokens + metadata, with the manual connection active.
    await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      "xoxb-bot",
    );
    await setSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
      "xapp-app",
    );
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-user",
    );
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    upsertCredentialMetadata("slack_channel", "user_token", {});
    manualConnectionStore["slack_channel"] = "active";

    const result = await credentialStoreTool.execute(
      {
        action: "delete",
        service: "slack_channel",
        field: "user_token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    // Routed through the surgical helper.
    expect(clearSlackUserTokenCalls).toBe(1);
    // oauth_connection row was never disconnected.
    expect(disconnectOAuthProviderCalls).toEqual([]);
    // user_token key + metadata removed.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
    const { getCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");
    expect(
      getCredentialMetadata("slack_channel", "user_token"),
    ).toBeUndefined();
    // bot + app tokens + their metadata + manual connection still present.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "bot_token")),
    ).toBe("xoxb-bot");
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "app_token")),
    ).toBe("xapp-app");
    expect(getCredentialMetadata("slack_channel", "bot_token")).toBeDefined();
    expect(getCredentialMetadata("slack_channel", "app_token")).toBeDefined();
    expect(manualConnectionStore["slack_channel"]).toBe("active");
  });

  test("delete with bot_token still tears down the oauth connection (regression guard)", async () => {
    await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      "xoxb-bot",
    );
    await setSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
      "xapp-app",
    );
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    manualConnectionStore["slack_channel"] = "active";

    const result = await credentialStoreTool.execute(
      {
        action: "delete",
        service: "slack_channel",
        field: "bot_token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    // Surgical helper was not used.
    expect(clearSlackUserTokenCalls).toBe(0);
    // Full teardown path called disconnectOAuthProvider for the slack_channel.
    expect(disconnectOAuthProviderCalls).toContain("slack_channel");
    // bot_token key + metadata removed.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "bot_token")),
    ).toBeUndefined();
    const { getCredentialMetadata } =
      await import("../tools/credentials/metadata-store.js");
    expect(getCredentialMetadata("slack_channel", "bot_token")).toBeUndefined();
  });

  test("delete with app_token still tears down the oauth connection (regression guard)", async () => {
    await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      "xoxb-bot",
    );
    await setSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
      "xapp-app",
    );
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    manualConnectionStore["slack_channel"] = "active";

    const result = await credentialStoreTool.execute(
      {
        action: "delete",
        service: "slack_channel",
        field: "app_token",
      },
      _ctx,
    );

    expect(result.isError).toBe(false);
    expect(clearSlackUserTokenCalls).toBe(0);
    expect(disconnectOAuthProviderCalls).toContain("slack_channel");
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "app_token")),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Vault — tool definition schema
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
    expect(props.action.enum).toEqual(["store", "list", "delete", "prompt"]);
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
// 6. Broker — serverUseById with transient not supported
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
// 7. Broker — revokeAll clears transient values indirectly via token cleanup
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

// ---------------------------------------------------------------------------
// 8. Broker — canonical capability key and legacy alias
// ---------------------------------------------------------------------------

describe("CredentialBroker — canonical capability key", () => {
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

  test("authorize succeeds with canonical key when metadata has canonical key", () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: [BROWSER_FILL_CAPABILITY],
    });

    const result = broker.authorize({
      service: "github",
      field: "token",
      toolName: BROWSER_FILL_CAPABILITY,
    });
    expect(result.authorized).toBe(true);
  });

  test("authorize succeeds with canonical key when metadata has legacy alias", () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });

    const result = broker.authorize({
      service: "github",
      field: "token",
      toolName: BROWSER_FILL_CAPABILITY,
    });
    expect(result.authorized).toBe(true);
  });

  test("authorize succeeds with legacy alias when metadata has canonical key", () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: [BROWSER_FILL_CAPABILITY],
    });

    const result = broker.authorize({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
    });
    expect(result.authorized).toBe(true);
  });

  test("serverUse with canonical key works when metadata has legacy alias", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("vercel", "api_token"), "vercel-tok");

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: BROWSER_FILL_CAPABILITY,
      execute: async (v) => v,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe("vercel-tok");
  });

  test("non-aliased tool names are unaffected by alias resolution", () => {
    upsertCredentialMetadata("svc", "key", {
      allowedTools: ["custom_tool"],
    });

    const result = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "custom_tool",
    });
    expect(result.authorized).toBe(true);
  });

  test("non-aliased tool denied when only canonical key is allowed", () => {
    upsertCredentialMetadata("svc", "key", {
      allowedTools: [BROWSER_FILL_CAPABILITY],
    });

    const result = broker.authorize({
      service: "svc",
      field: "key",
      toolName: "unrelated_tool",
    });
    expect(result.authorized).toBe(false);
  });
});
