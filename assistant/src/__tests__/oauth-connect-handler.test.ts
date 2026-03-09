import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-oauth-connect-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, "ipc-blobs"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Track config writes for accountInfo-to-config assertions
let lastSavedRawConfig: Record<string, unknown> | undefined;
let configCacheInvalidated = false;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({
    ingress: { publicBaseUrl: "https://test.example.com" },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: (raw: Record<string, unknown>) => {
    lastSavedRawConfig = raw;
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {
    configCacheInvalidated = true;
  },
  getNestedValue: (obj: Record<string, unknown>, path: string): unknown => {
    const keys = path.split(".");
    let current: unknown = obj;
    for (const key of keys) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  },
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ): void => {
    const keys = path.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] == null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
  },
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => "https://test.example.com",
  getOAuthCallbackUrl: () => "https://test.example.com/webhooks/oauth/callback",
}));

// Mock secure key storage
let secureKeyStore: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  setSecureKeyAsync: async (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKey: (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return "deleted";
    }
    return "not-found";
  },
  deleteSecureKeyAsync: async (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return "deleted" as const;
    }
    return "not-found" as const;
  },
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => "encrypted",
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

// Mock orchestrateOAuthConnect
import type { OAuthConnectResult } from "../oauth/connect-types.js";

let orchestratorResult: OAuthConnectResult | null = null;
let orchestratorError: Error | null = null;
let lastOrchestratorOptions: Record<string, unknown> | undefined;
let shouldCallOpenUrl = false;

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async (options: Record<string, unknown>) => {
    lastOrchestratorOptions = options;
    if (shouldCallOpenUrl && typeof options.openUrl === "function") {
      (options.openUrl as (url: string) => void)(
        "https://accounts.google.com/o/oauth2/v2/auth?test=1",
      );
    }
    if (orchestratorError) throw orchestratorError;
    return orchestratorResult;
  },
}));

// Mock credential metadata store
mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => ({}),
  deleteCredentialMetadata: () => false,
  listCredentialMetadata: () => [],
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

// Mock post-connect hooks (needed for direct storeOAuth2Tokens tests)
mock.module("../tools/credentials/post-connect-hooks.js", () => ({
  runPostConnectHook: async () => {},
}));

// Mock OAuth2 flow (required by other handlers that may be loaded transitively)
mock.module("../security/oauth2.js", () => ({
  startOAuth2Flow: async () => ({}),
  prepareOAuth2Flow: async () => ({}),
}));

import { handleMessage } from "../daemon/handlers/index.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type {
  OAuthConnectStartRequest,
  ServerMessage,
} from "../daemon/ipc-protocol.js";
import { storeOAuth2Tokens } from "../oauth/token-persistence.js";
import { DebouncerMap } from "../util/debounce.js";

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    cuSessions: new Map(),
    cuObservationParseSequence: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => {
      sent.push(msg);
    },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => {
      throw new Error("not implemented");
    },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe("OAuth connect handler", () => {
  beforeEach(() => {
    secureKeyStore = {};
    orchestratorResult = null;
    orchestratorError = null;
    lastOrchestratorOptions = undefined;
    shouldCallOpenUrl = false;
    lastSavedRawConfig = undefined;
    configCacheInvalidated = false;
  });

  test("missing service returns error", async () => {
    const msg = {
      type: "oauth_connect_start",
    } as unknown as OAuthConnectStartRequest;
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 10));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
      error?: string;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("service");
  });

  test("missing client_id returns error", async () => {
    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "gmail",
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 10));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
      error?: string;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("client_id");
  });

  test("successful orchestration returns correct IPC response", async () => {
    secureKeyStore["credential:integration:gmail:client_id"] = "test-client-id";
    secureKeyStore["credential:integration:gmail:client_secret"] =
      "test-client-secret";

    orchestratorResult = {
      success: true,
      deferred: false,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      accountInfo: "user@example.com",
    };

    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "gmail",
      requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
      grantedScopes?: string[];
      accountInfo?: string;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.grantedScopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(result.accountInfo).toBe("user@example.com");

    // Verify orchestrator was called with correct options
    expect(lastOrchestratorOptions).toBeDefined();
    expect(lastOrchestratorOptions!.service).toBe("gmail");
    expect(lastOrchestratorOptions!.clientId).toBe("test-client-id");
    expect(lastOrchestratorOptions!.clientSecret).toBe("test-client-secret");
    expect(lastOrchestratorOptions!.isInteractive).toBe(true);
    expect(lastOrchestratorOptions!.requestedScopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  test("orchestrator error returns sanitized failure", async () => {
    secureKeyStore["credential:integration:gmail:client_id"] = "test-client-id";
    secureKeyStore["credential:integration:gmail:client_secret"] =
      "test-client-secret";

    orchestratorResult = {
      success: false,
      error: 'Scope "admin" is forbidden for integration:gmail',
      safeError: true,
    };

    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "gmail",
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
      error?: string;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("forbidden");
  });

  test("exception during orchestration returns generic error", async () => {
    secureKeyStore["credential:integration:twitter:client_id"] =
      "test-client-id";

    orchestratorError = new Error(
      "OAuth2 flow timed out waiting for user authorization",
    );

    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "twitter",
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
      error?: string;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  test("client_id resolved via alias service name", async () => {
    // Store with the canonical service name (integration:twitter)
    secureKeyStore["credential:integration:twitter:client_id"] =
      "test-client-id-canonical";

    orchestratorResult = {
      success: true,
      deferred: false,
      grantedScopes: ["tweet.read"],
      accountInfo: "@testuser",
    };

    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "twitter",
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const result = sent.find((m) => m.type === "oauth_connect_result") as {
      type: string;
      success: boolean;
    };
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Verify the canonical key was used
    expect(lastOrchestratorOptions!.clientId).toBe("test-client-id-canonical");
  });

  test("openUrl callback sends open_url IPC message", async () => {
    secureKeyStore["credential:integration:gmail:client_id"] = "test-client-id";
    secureKeyStore["credential:integration:gmail:client_secret"] =
      "test-client-secret";

    orchestratorResult = {
      success: true,
      deferred: false,
      grantedScopes: [],
    };

    // Enable the openUrl callback in the top-level orchestrator mock
    shouldCallOpenUrl = true;

    const msg: OAuthConnectStartRequest = {
      type: "oauth_connect_start",
      service: "gmail",
    };
    const { ctx, sent } = createTestContext();
    await handleMessage(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const openUrlMsg = sent.find((m) => m.type === "open_url");
    expect(openUrlMsg).toBeDefined();
  });

  test("storeOAuth2Tokens writes accountInfo to config", async () => {
    const result = await storeOAuth2Tokens({
      service: "integration:gmail",
      tokens: { accessToken: "test-access-token" },
      grantedScopes: ["email"],
      rawTokenResponse: {},
      clientId: "test-client-id",
      tokenUrl: "https://oauth2.googleapis.com/token",
      identityAccountInfo: "user@example.com",
    });

    expect(result.accountInfo).toBe("user@example.com");

    // Verify accountInfo was written to config
    expect(lastSavedRawConfig).toBeDefined();
    const integrations = lastSavedRawConfig!.integrations as Record<
      string,
      unknown
    >;
    const accountInfoMap = integrations.accountInfo as Record<string, unknown>;
    expect(accountInfoMap["integration:gmail"]).toBe("user@example.com");
    expect(configCacheInvalidated).toBe(true);
  });

  test("storeOAuth2Tokens does not write to config when no accountInfo", async () => {
    const result = await storeOAuth2Tokens({
      service: "integration:gmail",
      tokens: { accessToken: "test-access-token" },
      grantedScopes: ["email"],
      rawTokenResponse: {},
      clientId: "test-client-id",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });

    expect(result.accountInfo).toBeUndefined();
    expect(lastSavedRawConfig).toBeUndefined();
    expect(configCacheInvalidated).toBe(false);
  });
});
