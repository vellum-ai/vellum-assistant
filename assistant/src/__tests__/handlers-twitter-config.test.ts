import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-twitter-cfg-test-"));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};
const saveRawConfigCalls: Record<string, unknown>[] = [];

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => structuredClone(rawConfigStore),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    saveRawConfigCalls.push(cfg);
    rawConfigStore = structuredClone(cfg);
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue,
  setNestedValue,
}));

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

// Mock secure key storage
let secureKeyStore: Record<string, string> = {};
// Allow tests to override setSecureKey behavior (e.g. to simulate storage failures)
let setSecureKeyOverride: ((account: string, value: string) => boolean) | null =
  null;

function syncSet(account: string, value: string): boolean {
  if (setSecureKeyOverride) return setSecureKeyOverride(account, value);
  secureKeyStore[account] = value;
  return true;
}

function syncDelete(account: string): "deleted" | "not-found" {
  if (account in secureKeyStore) {
    delete secureKeyStore[account];
    return "deleted";
  }
  return "not-found";
}

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: syncSet,
  deleteSecureKey: syncDelete,
  setSecureKeyAsync: async (account: string, value: string) =>
    syncSet(account, value),
  deleteSecureKeyAsync: async (account: string) => syncDelete(account),
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => "encrypted",
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

// Mock credential metadata store
let credentialMetadataStore: Array<{
  service: string;
  field: string;
  accountInfo?: string;
}> = [];
const deletedMetadata: Array<{ service: string; field: string }> = [];

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    credentialMetadataStore.find(
      (m) => m.service === service && m.field === field,
    ) ?? undefined,
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: Record<string, unknown>,
  ) => {
    const existing = credentialMetadataStore.find(
      (m) => m.service === service && m.field === field,
    );
    if (existing) {
      if (policy?.accountInfo !== undefined)
        existing.accountInfo = policy.accountInfo as string;
      return existing;
    }
    const record = {
      service,
      field,
      accountInfo: policy?.accountInfo as string | undefined,
    };
    credentialMetadataStore.push(record);
    return record;
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    deletedMetadata.push({ service, field });
    const idx = credentialMetadataStore.findIndex(
      (m) => m.service === service && m.field === field,
    );
    if (idx !== -1) {
      credentialMetadataStore.splice(idx, 1);
      return true;
    }
    return false;
  },
  listCredentialMetadata: () => credentialMetadataStore,
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

import { handleMessage } from "../daemon/handlers/index.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type {
  ClientMessage,
  ServerMessage,
  TwitterIntegrationConfigRequest,
} from "../daemon/ipc-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

/**
 * Wrapper around handleMessage that flushes the microtask queue so async
 * handlers complete before assertions run. handleMessage() returns void
 * and swallows the promise, so we need a macrotask tick to settle.
 */
async function handleMessageAsync(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  handleMessage(msg, socket, ctx);
  await new Promise<void>((r) => setTimeout(r, 0));
}

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
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

describe("Twitter integration config handler", () => {
  beforeEach(() => {
    rawConfigStore = {};
    saveRawConfigCalls.length = 0;
    secureKeyStore = {};
    setSecureKeyOverride = null;
    credentialMetadataStore = [];
    deletedMetadata.length = 0;
  });

  test("get action returns correct status when not configured", () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      mode: string;
      managedAvailable: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.mode).toBe("local_byo");
    expect(res.managedAvailable).toBe(false);
    expect(res.localClientConfigured).toBe(false);
    expect(res.connected).toBe(false);
  });

  test("get action returns correct status when configured and connected", () => {
    rawConfigStore = { twitter: { integrationMode: "local_byo" } };
    secureKeyStore["credential:integration:twitter:client_id"] =
      "test-client-id";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "test-access-token";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@testuser",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      mode: string;
      localClientConfigured: boolean;
      connected: boolean;
      accountInfo: string;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.mode).toBe("local_byo");
    expect(res.localClientConfigured).toBe(true);
    expect(res.connected).toBe(true);
    expect(res.accountInfo).toBe("@testuser");
  });

  test("set_mode persists mode in config", () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_mode",
      mode: "managed",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; mode: string };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.mode).toBe("managed");

    expect(saveRawConfigCalls).toHaveLength(1);
    expect(
      getNestedValue(saveRawConfigCalls[0]!, "twitter.integrationMode"),
    ).toBe("managed");
  });

  test("set_local_client stores credentials in secure storage", async () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);

    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "my-client-id",
    );
    expect(secureKeyStore["credential:integration:twitter:client_secret"]).toBe(
      "my-client-secret",
    );
  });

  test("set_local_client without clientId returns error", async () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain("clientId is required");
  });

  test("clear_local_client removes credentials", async () => {
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "my-client-secret";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "clear_local_client",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(false);
    expect(res.connected).toBe(false);

    expect(
      secureKeyStore["credential:integration:twitter:client_id"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:client_secret"],
    ).toBeUndefined();
  });

  test("clear_local_client also disconnects if connected", async () => {
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "test-token";
    secureKeyStore["credential:integration:twitter:refresh_token"] =
      "test-refresh";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@testuser",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "clear_local_client",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      connected: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.connected).toBe(false);

    expect(
      secureKeyStore["credential:integration:twitter:access_token"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:refresh_token"],
    ).toBeUndefined();
    expect(deletedMetadata).toContainEqual({
      service: "integration:twitter",
      field: "access_token",
    });
  });

  test("disconnect removes tokens and metadata", async () => {
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "test-token";
    secureKeyStore["credential:integration:twitter:refresh_token"] =
      "test-refresh";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@testuser",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "disconnect",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);
    expect(res.connected).toBe(false);

    expect(
      secureKeyStore["credential:integration:twitter:access_token"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:refresh_token"],
    ).toBeUndefined();
    // Client credentials should still be present after disconnect
    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "my-client-id",
    );
    expect(deletedMetadata).toContainEqual({
      service: "integration:twitter",
      field: "access_token",
    });
  });

  test("set_local_client returns error when setSecureKey fails for client ID", async () => {
    // Override setSecureKey to return false (storage unavailable, not throwing)
    setSecureKeyOverride = () => false;

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "will-fail-silently",
      clientSecret: "will-fail-secret",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      error?: string;
      localClientConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(false);
    expect(res.localClientConfigured).toBe(false);
    expect(res.error).toContain("Failed to store client ID");
  });

  test("set_local_client returns error when setSecureKey fails for client secret", async () => {
    // Override setSecureKey to fail only for the secret
    setSecureKeyOverride = (account: string, value: string) => {
      if (account.includes("client_secret")) return false;
      secureKeyStore[account] = value;
      return true;
    };

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "good-id",
      clientSecret: "will-fail-secret",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      error?: string;
      localClientConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(false);
    expect(res.localClientConfigured).toBe(false);
    expect(res.error).toContain("Failed to store client secret");
  });

  test("set_local_client without secret clears stale secret", async () => {
    // Pre-populate an old client secret
    secureKeyStore["credential:integration:twitter:client_id"] = "old-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "old-secret";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "new-id",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);

    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "new-id",
    );
    // Stale secret should be cleared
    expect(
      secureKeyStore["credential:integration:twitter:client_secret"],
    ).toBeUndefined();
  });

  test("unrecognized action returns error response", () => {
    const msg = {
      type: "twitter_integration_config",
      action: "nonexistent_action",
    } as unknown as TwitterIntegrationConfigRequest;

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Unknown action");
    expect(res.error).toContain("nonexistent_action");
  });

  // --- Regression tests ---

  test("mode persistence across get/set cycle", () => {
    // Set mode to managed
    const setManaged: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_mode",
      mode: "managed",
    };
    const { ctx: ctx1, sent: sent1 } = createTestContext();
    handleMessage(setManaged, {} as net.Socket, ctx1);
    expect(sent1).toHaveLength(1);
    expect((sent1[0] as { mode: string }).mode).toBe("managed");

    // Get should reflect managed mode
    const getMsg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };
    const { ctx: ctx2, sent: sent2 } = createTestContext();
    handleMessage(getMsg, {} as net.Socket, ctx2);
    expect(sent2).toHaveLength(1);
    expect((sent2[0] as { mode: string }).mode).toBe("managed");

    // Set mode back to local_byo
    const setLocal: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_mode",
      mode: "local_byo",
    };
    const { ctx: ctx3, sent: sent3 } = createTestContext();
    handleMessage(setLocal, {} as net.Socket, ctx3);
    expect(sent3).toHaveLength(1);
    expect((sent3[0] as { mode: string }).mode).toBe("local_byo");

    // Verify via get
    const { ctx: ctx4, sent: sent4 } = createTestContext();
    handleMessage(getMsg, {} as net.Socket, ctx4);
    expect(sent4).toHaveLength(1);
    expect((sent4[0] as { mode: string }).mode).toBe("local_byo");
  });

  test("set_local_client with only clientId (no secret)", async () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "id-only",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);

    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "id-only",
    );
    expect(
      secureKeyStore["credential:integration:twitter:client_secret"],
    ).toBeUndefined();
  });

  test("set_local_client overwrites existing credentials", async () => {
    // Set initial credentials
    secureKeyStore["credential:integration:twitter:client_id"] = "old-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "old-secret";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "new-id",
      clientSecret: "new-secret",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);

    // Verify overwritten values
    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "new-id",
    );
    expect(secureKeyStore["credential:integration:twitter:client_secret"]).toBe(
      "new-secret",
    );
  });

  test("clear_local_client when no credentials exist (idempotent)", async () => {
    // No credentials set at all
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "clear_local_client",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(false);
    expect(res.connected).toBe(false);
  });

  test("disconnect when not connected (idempotent) preserves client credentials", async () => {
    // Only client credentials, no access token
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "my-client-secret";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "disconnect",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.connected).toBe(false);
    // Client credentials should NOT be removed by disconnect
    expect(res.localClientConfigured).toBe(true);
    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "my-client-id",
    );
    expect(secureKeyStore["credential:integration:twitter:client_secret"]).toBe(
      "my-client-secret",
    );
  });

  test("disconnect preserves client credentials when access token exists", async () => {
    // Set up both client credentials and tokens
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "my-client-secret";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "active-token";
    secureKeyStore["credential:integration:twitter:refresh_token"] =
      "active-refresh";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@connected_user",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "disconnect",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.connected).toBe(false);
    expect(res.localClientConfigured).toBe(true);

    // Tokens removed
    expect(
      secureKeyStore["credential:integration:twitter:access_token"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:refresh_token"],
    ).toBeUndefined();
    // Client credentials preserved
    expect(secureKeyStore["credential:integration:twitter:client_id"]).toBe(
      "my-client-id",
    );
    expect(secureKeyStore["credential:integration:twitter:client_secret"]).toBe(
      "my-client-secret",
    );
    // Metadata deleted
    expect(deletedMetadata).toContainEqual({
      service: "integration:twitter",
      field: "access_token",
    });
  });

  test("clear_local_client cascades to remove tokens and metadata", async () => {
    // Set up client credentials, tokens, and metadata
    secureKeyStore["credential:integration:twitter:client_id"] = "my-client-id";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "my-client-secret";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "active-token";
    secureKeyStore["credential:integration:twitter:refresh_token"] =
      "active-refresh";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@connected_user",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "clear_local_client",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(false);
    expect(res.connected).toBe(false);

    // Everything should be gone
    expect(
      secureKeyStore["credential:integration:twitter:client_id"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:client_secret"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:access_token"],
    ).toBeUndefined();
    expect(
      secureKeyStore["credential:integration:twitter:refresh_token"],
    ).toBeUndefined();
    expect(deletedMetadata).toContainEqual({
      service: "integration:twitter",
      field: "access_token",
    });
  });

  test("get status with partial state — access token but no metadata", () => {
    // Only access token exists, no credential metadata
    secureKeyStore["credential:integration:twitter:access_token"] =
      "orphan-token";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      connected: boolean;
      accountInfo?: string;
      localClientConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.connected).toBe(true);
    expect(res.accountInfo).toBeUndefined();
    expect(res.localClientConfigured).toBe(false);
  });

  test("get status reflects localClientConfigured when only clientId exists", () => {
    // Only clientId, no secret
    secureKeyStore["credential:integration:twitter:client_id"] = "id-only";

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      localClientConfigured: boolean;
      connected: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.localClientConfigured).toBe(true);
    expect(res.connected).toBe(false);
  });

  test("error in secure storage throws and returns error response", async () => {
    // Override setSecureKey to throw an error, simulating a storage failure
    setSecureKeyOverride = () => {
      throw new Error("Keychain access denied");
    };

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_local_client",
      clientId: "will-fail",
      clientSecret: "will-fail-secret",
    };

    const { ctx, sent } = createTestContext();
    await handleMessageAsync(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Keychain access denied");

    // Credential values should not appear in the error response
    expect(JSON.stringify(res)).not.toContain("will-fail-secret");
    expect(JSON.stringify(res)).not.toContain("will-fail");
  });

  test("response messages never contain raw credential values", () => {
    // Set up credentials and tokens
    secureKeyStore["credential:integration:twitter:client_id"] =
      "secret-client-id-abc123";
    secureKeyStore["credential:integration:twitter:client_secret"] =
      "secret-client-secret-xyz789";
    secureKeyStore["credential:integration:twitter:access_token"] =
      "secret-access-token-def456";
    credentialMetadataStore.push({
      service: "integration:twitter",
      field: "access_token",
      accountInfo: "@testuser",
    });

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const responseStr = JSON.stringify(sent[0]);
    // No raw credential values should leak into the response
    expect(responseStr).not.toContain("secret-client-id-abc123");
    expect(responseStr).not.toContain("secret-client-secret-xyz789");
    expect(responseStr).not.toContain("secret-access-token-def456");
  });

  // --- Strategy tests ---

  test("get_strategy returns auto by default with strategyConfigured=false", () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get_strategy",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      strategy: string;
      strategyConfigured: boolean;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.strategy).toBe("auto");
    expect(res.strategyConfigured).toBe(false);
  });

  test("set_strategy persists and can be read back with strategyConfigured=true", () => {
    // Set strategy to oauth
    const setMsg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_strategy",
      strategy: "oauth",
    };
    const { ctx: ctx1, sent: sent1 } = createTestContext();
    handleMessage(setMsg, {} as net.Socket, ctx1);

    expect(sent1).toHaveLength(1);
    const setRes = sent1[0] as {
      type: string;
      success: boolean;
      strategy: string;
      strategyConfigured: boolean;
    };
    expect(setRes.success).toBe(true);
    expect(setRes.strategy).toBe("oauth");
    expect(setRes.strategyConfigured).toBe(true);

    // Read it back with get_strategy
    const getMsg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get_strategy",
    };
    const { ctx: ctx2, sent: sent2 } = createTestContext();
    handleMessage(getMsg, {} as net.Socket, ctx2);

    expect(sent2).toHaveLength(1);
    const getRes = sent2[0] as {
      type: string;
      success: boolean;
      strategy: string;
      strategyConfigured: boolean;
    };
    expect(getRes.success).toBe(true);
    expect(getRes.strategy).toBe("oauth");
    expect(getRes.strategyConfigured).toBe(true);

    // Verify persistence via saveRawConfig
    expect(saveRawConfigCalls.length).toBeGreaterThan(0);
    const lastSaved = saveRawConfigCalls[saveRawConfigCalls.length - 1]!;
    expect(getNestedValue(lastSaved, "twitter.operationStrategy")).toBe(
      "oauth",
    );
  });

  test("set_strategy with invalid value returns error", () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "set_strategy",
      strategy: "invalid_value",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid strategy value");
    expect(res.error).toContain("invalid_value");
  });

  test("set_strategy without value returns error", () => {
    const msg = {
      type: "twitter_integration_config",
      action: "set_strategy",
    } as unknown as TwitterIntegrationConfigRequest;

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid strategy value");
  });

  test("get action includes strategy field with strategyConfigured=true when set", () => {
    // Set a specific strategy first
    rawConfigStore = { twitter: { operationStrategy: "browser" } };

    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      strategy: string;
      strategyConfigured: boolean;
      mode: string;
    };
    expect(res.type).toBe("twitter_integration_config_response");
    expect(res.success).toBe(true);
    expect(res.strategy).toBe("browser");
    expect(res.strategyConfigured).toBe(true);
  });

  test("get action returns auto strategy by default with strategyConfigured=false", () => {
    const msg: TwitterIntegrationConfigRequest = {
      type: "twitter_integration_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleMessage(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      strategy: string;
      strategyConfigured: boolean;
    };
    expect(res.strategy).toBe("auto");
    expect(res.strategyConfigured).toBe(false);
  });

  test("set_strategy cycles through all valid values", () => {
    for (const value of ["oauth", "browser", "auto"] as const) {
      const msg: TwitterIntegrationConfigRequest = {
        type: "twitter_integration_config",
        action: "set_strategy",
        strategy: value,
      };
      const { ctx, sent } = createTestContext();
      handleMessage(msg, {} as net.Socket, ctx);
      expect(sent).toHaveLength(1);
      const res = sent[0] as {
        type: string;
        success: boolean;
        strategy: string;
      };
      expect(res.success).toBe(true);
      expect(res.strategy).toBe(value);
    }
  });
});
