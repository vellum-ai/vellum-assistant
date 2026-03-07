import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-twitter-auth-test-"));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};
let mockIngressPublicBaseUrl: string | undefined = "https://test.example.com";

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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({ ingress: { publicBaseUrl: mockIngressPublicBaseUrl } }),
  loadRawConfig: () => structuredClone(rawConfigStore),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = structuredClone(cfg);
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl;
    if (url) return url;
    throw new Error("No public base URL configured.");
  },
  getOAuthCallbackUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl;
    if (!url) throw new Error("No public base URL configured.");
    return `${url}/webhooks/oauth/callback`;
  },
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

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
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
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => "encrypted",
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

// Mock the orchestrator — the handler now delegates to orchestrateOAuthConnect
import type { OAuthConnectResult } from "../oauth/connect-types.js";

let orchestratorResult: OAuthConnectResult | null = null;
let orchestratorError: Error | null = null;
let lastOrchestratorOptions: Record<string, unknown> | undefined;

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async (options: Record<string, unknown>) => {
    lastOrchestratorOptions = options;
    // Trigger the openUrl callback so tests can verify the open_url message is sent
    if (typeof options.openUrl === "function") {
      (options.openUrl as (url: string) => void)(
        "https://twitter.com/i/oauth2/authorize?test=1",
      );
    }
    if (orchestratorError) throw orchestratorError;
    return orchestratorResult;
  },
}));

// Mock credential metadata store
let credentialMetadataStore: Array<{
  service: string;
  field: string;
  accountInfo?: string;
}> = [];

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
  ServerMessage,
  TwitterAuthStartRequest,
  TwitterAuthStatusRequest,
} from "../daemon/ipc-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

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

describe("Twitter auth handler", () => {
  beforeEach(() => {
    rawConfigStore = {};
    secureKeyStore = {};
    credentialMetadataStore = [];
    orchestratorResult = null;
    orchestratorError = null;
    lastOrchestratorOptions = undefined;
    mockIngressPublicBaseUrl = "https://test.example.com";
  });

  describe("twitter_auth_start", () => {
    test("fails if mode is not local_byo", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      // handleMessage returns void, the async handler runs; wait a tick
      await new Promise((r) => setTimeout(r, 10));

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain("local_byo");
    });

    test("fails if no client credentials configured", async () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      // No client ID in secure storage

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 10));

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain("client credentials");
    });

    test("succeeds with valid config (mock orchestrator)", async () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      secureKeyStore["credential:integration:twitter:client_id"] =
        "test-client-id";
      secureKeyStore["credential:integration:twitter:client_secret"] =
        "test-client-secret";

      orchestratorResult = {
        success: true,
        deferred: false,
        grantedScopes: ["tweet.read", "users.read", "offline.access"],
        accountInfo: "@testuser",
      };

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      // Should have sent open_url and then twitter_auth_result
      const openUrlMsg = sent.find((m) => m.type === "open_url");
      expect(openUrlMsg).toBeDefined();

      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        accountInfo?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.accountInfo).toBe("@testuser");
    });

    test("delegates to orchestrateOAuthConnect with correct options", async () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      secureKeyStore["credential:integration:twitter:client_id"] =
        "test-client-id";
      secureKeyStore["credential:integration:twitter:client_secret"] =
        "test-client-secret";

      orchestratorResult = {
        success: true,
        deferred: false,
        grantedScopes: ["tweet.read", "users.read", "offline.access"],
        accountInfo: "@testuser",
      };

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      expect(lastOrchestratorOptions).toBeDefined();
      expect(lastOrchestratorOptions!.service).toBe("integration:twitter");
      expect(lastOrchestratorOptions!.clientId).toBe("test-client-id");
      expect(lastOrchestratorOptions!.clientSecret).toBe("test-client-secret");
      expect(lastOrchestratorOptions!.isInteractive).toBe(true);
      expect(lastOrchestratorOptions!.allowedTools).toEqual(["twitter_post"]);
      expect(typeof lastOrchestratorOptions!.openUrl).toBe("function");
    });

    test("fails fast with actionable error when no ingress URL is configured", async () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      secureKeyStore["credential:integration:twitter:client_id"] =
        "test-client-id";
      mockIngressPublicBaseUrl = undefined;

      orchestratorResult = {
        success: true,
        deferred: false,
        grantedScopes: [],
      };

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      // Should NOT have sent open_url — the flow should fail before reaching the orchestrator
      const openUrlMsg = sent.find((m) => m.type === "open_url");
      expect(openUrlMsg).toBeUndefined();

      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain("ingress.publicBaseUrl");
      expect(result.error).toContain("INGRESS_PUBLIC_BASE_URL");
      expect(result.error).toContain("/webhooks/oauth/callback");

      // orchestrateOAuthConnect should not have been called
      expect(lastOrchestratorOptions).toBeUndefined();
    });

    test("maps orchestrator error result to twitter_auth_result", async () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      secureKeyStore["credential:integration:twitter:client_id"] =
        "test-client-id";

      orchestratorResult = {
        success: false,
        error: "Failed to verify Twitter identity. Please try again.",
        safeError: true,
      };

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Failed to verify Twitter identity. Please try again.",
      );
    });

    describe("auth hardening", () => {
      test("OAuth cancel path returns sanitized failure", async () => {
        rawConfigStore = { twitter: { integrationMode: "local_byo" } };
        secureKeyStore["credential:integration:twitter:client_id"] =
          "test-client-id";

        orchestratorError = new Error(
          "OAuth2 authorization denied: user_cancelled",
        );

        const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === "twitter_auth_result") as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.error).toBe("Twitter authentication was cancelled.");
      });

      test("OAuth timeout path returns sanitized failure", async () => {
        rawConfigStore = { twitter: { integrationMode: "local_byo" } };
        secureKeyStore["credential:integration:twitter:client_id"] =
          "test-client-id";

        orchestratorError = new Error(
          "OAuth2 flow timed out waiting for user authorization",
        );

        const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === "twitter_auth_result") as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          "Twitter authentication timed out. Please try again.",
        );
      });

      test("error payload never includes secrets or raw provider bodies", async () => {
        rawConfigStore = { twitter: { integrationMode: "local_byo" } };
        secureKeyStore["credential:integration:twitter:client_id"] =
          "test-client-id";

        orchestratorError = new Error(
          'OAuth2 token exchange failed (403): {"error":"invalid_client","client_secret":"super-secret-123"}',
        );

        const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === "twitter_auth_result") as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);

        // The error should NOT contain any secrets or raw provider details
        expect(result.error).not.toContain("super-secret-123");
        expect(result.error).not.toContain("invalid_client");
        expect(result.error).not.toContain("client_secret");

        // Should fall to default classification since the raw message does not match
        // "denied", "invalid_grant", "timed out", or "cancelled"
        expect(result.error).toBe(
          "Twitter authentication failed. Please try again.",
        );
      });

      test("succeeds even when identity verification returns no accountInfo", async () => {
        rawConfigStore = { twitter: { integrationMode: "local_byo" } };
        secureKeyStore["credential:integration:twitter:client_id"] =
          "test-client-id";

        // Identity verification is non-fatal in the orchestrator — accountInfo may be undefined
        orchestratorResult = {
          success: true,
          deferred: false,
          grantedScopes: ["tweet.read", "users.read", "offline.access"],
          accountInfo: undefined,
        };

        const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === "twitter_auth_result") as {
          type: string;
          success: boolean;
          accountInfo?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(true);
        // accountInfo may be undefined when identity verification is not possible
        expect(result.accountInfo).toBeUndefined();
      });
    });
  });

  describe("twitter_auth_status", () => {
    test("returns disconnected when no token exists", () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };

      const msg: TwitterAuthStatusRequest = { type: "twitter_auth_status" };
      const { ctx, sent } = createTestContext();
      handleMessage(msg, {} as net.Socket, ctx);

      expect(sent).toHaveLength(1);
      const result = sent[0] as {
        type: string;
        connected: boolean;
        accountInfo?: string;
        mode?: string;
      };
      expect(result.type).toBe("twitter_auth_status_response");
      expect(result.connected).toBe(false);
      expect(result.accountInfo).toBeUndefined();
      expect(result.mode).toBe("local_byo");
    });

    test("returns connected with account info when token exists", () => {
      rawConfigStore = { twitter: { integrationMode: "local_byo" } };
      secureKeyStore["credential:integration:twitter:access_token"] =
        "test-access-token";
      credentialMetadataStore.push({
        service: "integration:twitter",
        field: "access_token",
        accountInfo: "@testuser",
      });

      const msg: TwitterAuthStatusRequest = { type: "twitter_auth_status" };
      const { ctx, sent } = createTestContext();
      handleMessage(msg, {} as net.Socket, ctx);

      expect(sent).toHaveLength(1);
      const result = sent[0] as {
        type: string;
        connected: boolean;
        accountInfo?: string;
        mode?: string;
      };
      expect(result.type).toBe("twitter_auth_status_response");
      expect(result.connected).toBe(true);
      expect(result.accountInfo).toBe("@testuser");
      expect(result.mode).toBe("local_byo");
    });
  });
});
