/**
 * Regression tests for managed Twitter OAuth guardrails.
 *
 * Verifies three critical invariants:
 * 1. Managed mode never falls back to local BYO connect flow
 * 2. Non-owner users are blocked from managed Twitter UI and control-plane calls
 * 3. Runtime never supplies a user selector for managed Twitter (uses assistant API key)
 */

import { mkdtempSync } from "node:fs";
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
  getWorkspaceDir: () => testDir,
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
  getSecureKey: (account: string) => {
    if (account === "credential:vellum:platform_assistant_id")
      return "ast_test123";
    return secureKeyStore[account] ?? undefined;
  },
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

import type { RouteContext } from "../runtime/http-router.js";
import { settingsRouteDefinitions } from "../runtime/routes/settings-routes.js";
import {
  mapProxyError,
  resolvePrerequisites,
  TwitterProxyError,
} from "../twitter/platform-proxy-client.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Find a route definition by endpoint from the settings route table.
 */
function findRoute(endpoint: string) {
  const routes = settingsRouteDefinitions();
  const route = routes.find((r) => r.endpoint === endpoint);
  if (!route) {
    throw new Error(`Route not found: ${endpoint}`);
  }
  return route;
}

/**
 * Call a route handler with a minimal RouteContext.
 */
function callRoute(
  endpoint: string,
  options?: { method?: string; body?: unknown },
): Promise<Response> | Response {
  const route = findRoute(endpoint);
  const url = new URL(`http://localhost/v1/${endpoint}`);
  const req = new Request(url.toString(), {
    method: options?.method ?? route.method,
    ...(options?.body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  const ctx = {
    req,
    url,
    server: {} as RouteContext["server"],
    authContext: {} as RouteContext["authContext"],
    params: {},
  } satisfies RouteContext;
  return route.handler(ctx);
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

      const response = await callRoute("integrations/twitter/auth/start", {
        method: "POST",
      });

      expect(orchestratorCalled).toBe(false);
      expect(response.status).toBe(400);
      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        errorCode?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("managed_missing_api_key");
    });

    test("returns managed-specific error code when prerequisites are met but auth is platform-handled", async () => {
      rawConfigStore = { twitter: { integrationMode: "managed" } };
      secureKeyStore["credential:vellum:assistant_api_key"] = "test-key";

      const response = await callRoute("integrations/twitter/auth/start", {
        method: "POST",
      });

      expect(orchestratorCalled).toBe(false);
      expect(response.status).toBe(400);
      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        errorCode?: string;
      };
      expect(result.ok).toBe(false);
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

      await callRoute("integrations/twitter/auth/start", { method: "POST" });

      expect(orchestratorCalled).toBe(false);
    });
  });

  // =========================================================================
  // Guardrail 2: Non-owner users are blocked from managed Twitter operations
  // =========================================================================

  describe("non-owner users are blocked from managed Twitter UI and control-plane calls", () => {
    test("proxy client surfaces owner_only error for non-owner 403", () => {
      // Exercise the production mapProxyError path with a 403 containing
      // "owner" in the detail — must yield an actionable owner_only error.
      const error = mapProxyError(403, {
        detail: "Only the owner can perform this action",
      });

      expect(error).toBeInstanceOf(TwitterProxyError);
      expect(error.code).toBe("owner_only");
      expect(error.message).toBe("Sign in as the assistant owner");
      expect(error.retryable).toBe(false);
      expect(error.statusCode).toBe(403);
    });

    test("proxy client surfaces owner_credential_required for missing credential 403", () => {
      // Exercise the production mapProxyError path with a 403 containing
      // both "owner" and "credential" — must yield owner_credential_required.
      const error = mapProxyError(403, {
        detail: "Owner credential required to access this resource",
      });

      expect(error).toBeInstanceOf(TwitterProxyError);
      expect(error.code).toBe("owner_credential_required");
      expect(error.message).toBe(
        "Connect Twitter in Settings as the assistant owner",
      );
      expect(error.retryable).toBe(false);
      expect(error.statusCode).toBe(403);
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
