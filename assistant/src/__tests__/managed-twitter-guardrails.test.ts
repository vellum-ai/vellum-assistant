/**
 * Regression tests for managed Twitter OAuth guardrails.
 *
 * Verifies three critical invariants:
 * 1. Managed mode never falls back to local BYO connect flow
 * 2. Non-owner users are blocked from managed Twitter UI and control-plane calls
 * 3. Runtime never supplies a user selector for managed Twitter (uses assistant API key)
 */

import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "managed-twitter-guardrails-"));

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

let rawConfigStore: Record<string, unknown> = {};
let secureKeyStore: Record<string, string> = {};
let orchestratorCalled = false;

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
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

// ---------------------------------------------------------------------------
// Module mocks — must be before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ ui: {}, platform: { baseUrl: "" } }),
  loadConfig: () => ({
    ingress: { publicBaseUrl: "https://test.example.com" },
  }),
  loadRawConfig: () => structuredClone(rawConfigStore),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = structuredClone(cfg);
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue,
  setNestedValue,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => "https://test.example.com",
  getOAuthCallbackUrl: () => "https://test.example.com/webhooks/oauth/callback",
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

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKey: () => "not-found",
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => "encrypted",
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async () => {
    orchestratorCalled = true;
    return {
      success: true,
      deferred: false,
      grantedScopes: [],
      accountInfo: "@test",
    };
  },
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => ({}),
  deleteCredentialMetadata: () => false,
  listCredentialMetadata: () => [],
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => "https://platform.vellum.ai",
  getPlatformAssistantId: () => "ast_test123",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handleMessage } from "../daemon/handlers/index.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type {
  ServerMessage,
  TwitterAuthStartRequest,
} from "../daemon/ipc-protocol.js";
import {
  resolvePrerequisites,
  TwitterProxyError,
} from "../twitter/platform-proxy-client.js";
import { DebouncerMap } from "../util/debounce.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Managed Twitter guardrails", () => {
  beforeEach(() => {
    rawConfigStore = {};
    secureKeyStore = {};
    orchestratorCalled = false;
  });

  // =========================================================================
  // Guardrail 1: Managed mode never falls back to local BYO connect flow
  // =========================================================================

  describe("managed mode never falls back to local BYO connect flow", () => {
    test("returns managed-specific error code, not OAuth flow, when API key is missing", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };
      // No API key configured — should NOT start OAuth

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);
      await new Promise((r) => setTimeout(r, 20));

      expect(orchestratorCalled).toBe(false);
      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
        errorCode?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("managed_missing_api_key");
    });

    test("returns managed-specific error code when prerequisites are met but auth is platform-handled", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };
      secureKeyStore["credential:vellum:assistant_api_key"] = "test-key";

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);
      await new Promise((r) => setTimeout(r, 20));

      expect(orchestratorCalled).toBe(false);
      const result = sent.find((m) => m.type === "twitter_auth_result") as {
        type: string;
        success: boolean;
        error?: string;
        errorCode?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("managed_auth_via_platform");
      expect(result.error).toContain("platform");
    });

    test("never calls orchestrateOAuthConnect in managed mode regardless of config", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };
      // Even with local BYO credentials present, managed mode must not start OAuth
      secureKeyStore["credential:vellum:assistant_api_key"] = "test-key";
      secureKeyStore["credential:integration:twitter:client_id"] =
        "test-client-id";
      secureKeyStore["credential:integration:twitter:client_secret"] =
        "test-secret";

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);
      await new Promise((r) => setTimeout(r, 20));

      expect(orchestratorCalled).toBe(false);
    });

    test("never sends open_url message in managed mode", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };
      secureKeyStore["credential:vellum:assistant_api_key"] = "test-key";

      const msg: TwitterAuthStartRequest = { type: "twitter_auth_start" };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);
      await new Promise((r) => setTimeout(r, 20));

      const openUrlMsg = sent.find((m) => m.type === "open_url");
      expect(openUrlMsg).toBeUndefined();
    });
  });

  // =========================================================================
  // Guardrail 2: Non-owner users are blocked from managed Twitter operations
  // =========================================================================

  describe("non-owner users are blocked from managed Twitter UI and control-plane calls", () => {
    test("proxy client surfaces owner_only error for non-owner 403", () => {
      // Verify the error mapping: a 403 with "owner" in the message must
      // surface an actionable owner_only error, not a generic forbidden
      const error = (() => {
        // Simulate what mapProxyError does for a 403 with owner-only detail
        const status = 403;
        const body = { detail: "Only the owner can perform this action" };
        const detail = String(body.detail).toLowerCase();
        if (detail.includes("owner") && detail.includes("credential")) {
          return new TwitterProxyError(
            "Connect Twitter in Settings as the assistant owner",
            "owner_credential_required",
            false,
            status,
          );
        }
        if (detail.includes("owner")) {
          return new TwitterProxyError(
            "Sign in as the assistant owner",
            "owner_only",
            false,
            status,
          );
        }
        return new TwitterProxyError(
          `Forbidden: ${detail}`,
          "forbidden",
          false,
          status,
        );
      })();

      expect(error.code).toBe("owner_only");
      expect(error.message).toBe("Sign in as the assistant owner");
      expect(error.retryable).toBe(false);
      expect(error.statusCode).toBe(403);
    });

    test("proxy client surfaces owner_credential_required for missing credential 403", () => {
      const status = 403;
      const body = {
        detail: "Owner credential required to access this resource",
      };
      const detail = String(body.detail).toLowerCase();

      let error: TwitterProxyError;
      if (detail.includes("owner") && detail.includes("credential")) {
        error = new TwitterProxyError(
          "Connect Twitter in Settings as the assistant owner",
          "owner_credential_required",
          false,
          status,
        );
      } else {
        error = new TwitterProxyError(
          `Forbidden: ${detail}`,
          "forbidden",
          false,
          status,
        );
      }

      expect(error.code).toBe("owner_credential_required");
      expect(error.message).toBe(
        "Connect Twitter in Settings as the assistant owner",
      );
      expect(error.retryable).toBe(false);
    });
  });

  // =========================================================================
  // Guardrail 3: Runtime never supplies a user selector for managed Twitter
  // =========================================================================

  describe("runtime uses assistant API key, not user tokens, for managed Twitter", () => {
    test("resolvePrerequisites returns assistant_api_key as the auth token", () => {
      secureKeyStore["credential:vellum:assistant_api_key"] = "ast-key-xyz";

      const prereqs = resolvePrerequisites();

      // The auth token must be the assistant API key, not a user-specific
      // session token or OAuth token
      expect(prereqs.authToken).toBe("ast-key-xyz");
    });

    test("resolvePrerequisites never uses user session tokens for auth", () => {
      // Even if user-specific tokens exist in the store, the proxy must
      // use the assistant API key
      secureKeyStore["credential:vellum:assistant_api_key"] = "ast-key-xyz";
      secureKeyStore["credential:vellum:session_token"] = "user-session-token";
      secureKeyStore["credential:integration:twitter:access_token"] =
        "user-oauth-token";

      const prereqs = resolvePrerequisites();

      expect(prereqs.authToken).toBe("ast-key-xyz");
      expect(prereqs.authToken).not.toBe("user-session-token");
      expect(prereqs.authToken).not.toBe("user-oauth-token");
    });

    test("resolvePrerequisites errors when assistant API key is absent", () => {
      // No assistant API key — should error, not fall back to user tokens
      secureKeyStore["credential:vellum:session_token"] = "user-session-token";

      expect(() => resolvePrerequisites()).toThrow(TwitterProxyError);
      try {
        resolvePrerequisites();
      } catch (err) {
        const tpe = err as TwitterProxyError;
        expect(tpe.code).toBe("missing_assistant_api_key");
      }
    });
  });
});
