/**
 * Tests for CES local subject resolution and credential materialisation.
 *
 * Covers:
 * 1. UUID and service/field refs for static credentials
 * 2. Disconnected OAuth handles (missing connection, missing access token)
 * 3. Missing secure keys (metadata present but secret missing)
 * 4. Refresh-on-expiry for OAuth tokens
 * 5. Deterministic failure behaviour before any network call or command launch
 * 6. Circuit breaker tripping after repeated refresh failures
 * 7. Provider key mismatch on OAuth handles
 * 8. Non-local handle types rejected by the local resolver
 */

import { describe, expect, test } from "bun:test";

import {
  HandleType,
  localStaticHandle,
  localOAuthHandle,
  platformOAuthHandle,
} from "@vellumai/ces-contracts";
import {
  type OAuthConnectionRecord,
  type SecureKeyBackend,
  type SecureKeyDeleteResult,
  type StaticCredentialRecord,
  StaticCredentialMetadataStore,
  oauthConnectionAccessTokenPath,
  oauthConnectionRefreshTokenPath,
  REFRESH_FAILURE_THRESHOLD,
} from "@vellumai/credential-storage";

import {
  resolveLocalSubject,
  type OAuthConnectionLookup,
  type LocalSubjectResolverDeps,
} from "../subjects/local.js";
import {
  LocalMaterialiser,
  type TokenRefreshFn,
} from "../materializers/local.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * In-memory secure-key backend for testing. Stores key-value pairs in a Map.
 */
function createMemoryBackend(
  initial: Record<string, string> = {},
): SecureKeyBackend {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async set(key: string, value: string): Promise<boolean> {
      store.set(key, value);
      return true;
    },
    async delete(key: string): Promise<SecureKeyDeleteResult> {
      if (store.has(key)) {
        store.delete(key);
        return "deleted";
      }
      return "not-found";
    },
    async list(): Promise<string[]> {
      return Array.from(store.keys());
    },
  };
}

/**
 * Build a minimal static credential record for testing.
 */
function buildStaticRecord(
  overrides: Partial<StaticCredentialRecord> = {},
): StaticCredentialRecord {
  return {
    credentialId: overrides.credentialId ?? "cred-uuid-1",
    service: overrides.service ?? "github",
    field: overrides.field ?? "api_key",
    allowedTools: overrides.allowedTools ?? [],
    allowedDomains: overrides.allowedDomains ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

/**
 * Build a minimal OAuth connection record for testing.
 */
function buildOAuthConnection(
  overrides: Partial<OAuthConnectionRecord> = {},
): OAuthConnectionRecord {
  return {
    id: overrides.id ?? "conn-uuid-1",
    providerKey: overrides.providerKey ?? "integration:google",
    accountInfo: overrides.accountInfo ?? "user@example.com",
    grantedScopes: overrides.grantedScopes ?? ["openid", "email"],
    accessTokenPath: overrides.accessTokenPath ??
      oauthConnectionAccessTokenPath("conn-uuid-1"),
    hasRefreshToken: overrides.hasRefreshToken ?? true,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

/**
 * Create an in-memory OAuth connection lookup backed by a Map.
 */
function createOAuthLookup(
  connections: OAuthConnectionRecord[] = [],
): OAuthConnectionLookup {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return {
    getById(connectionId: string) {
      return byId.get(connectionId);
    },
  };
}

/**
 * Create a StaticCredentialMetadataStore backed by an in-memory JSON file.
 * Uses a temporary path that is unique per test.
 */
function createMemoryMetadataStore(
  records: StaticCredentialRecord[] = [],
): StaticCredentialMetadataStore {
  const tmpPath = `/tmp/ces-test-metadata-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const store = new StaticCredentialMetadataStore(tmpPath);
  // Seed records by upserting them
  for (const r of records) {
    store.upsert(r.service, r.field, {
      allowedTools: r.allowedTools,
      allowedDomains: r.allowedDomains,
      usageDescription: r.usageDescription,
      alias: r.alias,
      injectionTemplates: r.injectionTemplates,
    });
  }
  return store;
}

/**
 * Create resolver deps from lists of records and connections.
 */
function createResolverDeps(opts: {
  staticRecords?: StaticCredentialRecord[];
  oauthConnections?: OAuthConnectionRecord[];
}): LocalSubjectResolverDeps {
  return {
    metadataStore: createMemoryMetadataStore(opts.staticRecords ?? []),
    oauthConnections: createOAuthLookup(opts.oauthConnections ?? []),
  };
}

// ---------------------------------------------------------------------------
// 1. Local static subject resolution
// ---------------------------------------------------------------------------

describe("local static subject resolution", () => {
  test("resolves a valid service/field handle to a static subject", () => {
    const record = buildStaticRecord({
      service: "github",
      field: "api_key",
    });
    const deps = createResolverDeps({ staticRecords: [record] });
    const handle = localStaticHandle("github", "api_key");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject.type).toBe(HandleType.LocalStatic);
    if (result.subject.type !== HandleType.LocalStatic) return;
    expect(result.subject.metadata.service).toBe("github");
    expect(result.subject.metadata.field).toBe("api_key");
    expect(result.subject.storageKey).toBe("credential/github/api_key");
  });

  test("fails when no metadata exists for the service/field", () => {
    const deps = createResolverDeps({ staticRecords: [] });
    const handle = localStaticHandle("nonexistent", "key");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No local static credential found/);
    expect(result.error).toMatch(/nonexistent/);
  });

  test("resolves different service/field combinations independently", () => {
    const records = [
      buildStaticRecord({ service: "fal", field: "api_key" }),
      buildStaticRecord({ service: "github", field: "token" }),
    ];
    const deps = createResolverDeps({ staticRecords: records });

    const falResult = resolveLocalSubject(
      localStaticHandle("fal", "api_key"),
      deps,
    );
    const ghResult = resolveLocalSubject(
      localStaticHandle("github", "token"),
      deps,
    );

    expect(falResult.ok).toBe(true);
    expect(ghResult.ok).toBe(true);
    if (!falResult.ok || !ghResult.ok) return;
    expect(falResult.subject.type).toBe(HandleType.LocalStatic);
    expect(ghResult.subject.type).toBe(HandleType.LocalStatic);
  });
});

// ---------------------------------------------------------------------------
// 2. Local OAuth subject resolution
// ---------------------------------------------------------------------------

describe("local OAuth subject resolution", () => {
  test("resolves a valid OAuth handle to an OAuth subject", () => {
    const conn = buildOAuthConnection({
      id: "conn-abc",
      providerKey: "integration:google",
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:google", "conn-abc");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject.type).toBe(HandleType.LocalOAuth);
    if (result.subject.type !== HandleType.LocalOAuth) return;
    expect(result.subject.connection.id).toBe("conn-abc");
    expect(result.subject.connection.providerKey).toBe("integration:google");
  });

  test("fails when the connection does not exist", () => {
    const deps = createResolverDeps({ oauthConnections: [] });
    const handle = localOAuthHandle("integration:google", "missing-conn");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No local OAuth connection found/);
    expect(result.error).toMatch(/missing-conn/);
  });

  test("fails when provider key in handle does not match connection", () => {
    const conn = buildOAuthConnection({
      id: "conn-xyz",
      providerKey: "integration:slack",
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    // Handle says google but connection is slack
    const handle = localOAuthHandle("integration:google", "conn-xyz");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/providerKey/);
    expect(result.error).toMatch(/integration:slack/);
    expect(result.error).toMatch(/integration:google/);
  });
});

// ---------------------------------------------------------------------------
// 3. Non-local handle types rejected
// ---------------------------------------------------------------------------

describe("non-local handle rejection", () => {
  test("rejects platform_oauth handles in the local resolver", () => {
    const deps = createResolverDeps({});
    const handle = platformOAuthHandle("platform-conn-123");

    const result = resolveLocalSubject(handle, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a local handle/);
  });

  test("rejects malformed handles", () => {
    const deps = createResolverDeps({});

    const result = resolveLocalSubject("garbage-no-colon", deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid handle format/);
  });

  test("rejects unknown handle type prefixes", () => {
    const deps = createResolverDeps({});

    const result = resolveLocalSubject("unknown_type:foo/bar", deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unknown handle type/);
  });
});

// ---------------------------------------------------------------------------
// 4. Static credential materialisation
// ---------------------------------------------------------------------------

describe("static credential materialisation", () => {
  test("materialises a stored secret value", async () => {
    const record = buildStaticRecord({
      service: "fal",
      field: "api_key",
    });
    const deps = createResolverDeps({ staticRecords: [record] });
    const handle = localStaticHandle("fal", "api_key");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      "credential/fal/api_key": "secret-fal-key-123",
    });
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("secret-fal-key-123");
    expect(result.credential.handleType).toBe(HandleType.LocalStatic);
  });

  test("fails when the secure key is missing (metadata without secret)", async () => {
    const record = buildStaticRecord({
      service: "github",
      field: "token",
    });
    const deps = createResolverDeps({ staticRecords: [record] });
    const handle = localStaticHandle("github", "token");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Empty backend — no secret stored
    const backend = createMemoryBackend({});
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Secure key/);
    expect(result.error).toMatch(/not found/);
    expect(result.error).toMatch(/credential\/github\/token/);
  });
});

// ---------------------------------------------------------------------------
// 5. OAuth token materialisation
// ---------------------------------------------------------------------------

describe("OAuth token materialisation", () => {
  test("materialises a valid non-expired access token", async () => {
    const conn = buildOAuthConnection({
      id: "conn-1",
      providerKey: "integration:google",
      // Token expires in the future (1 hour from now)
      expiresAt: Date.now() + 60 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:google", "conn-1");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-1")]: "ya29.valid-token",
    });
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("ya29.valid-token");
    expect(result.credential.handleType).toBe(HandleType.LocalOAuth);
  });

  test("fails when no access token is stored (disconnected connection)", async () => {
    const conn = buildOAuthConnection({
      id: "conn-disconnected",
      providerKey: "integration:slack",
      hasRefreshToken: false,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:slack", "conn-disconnected");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Empty backend — no access token
    const backend = createMemoryBackend({});
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No access token found/);
    expect(result.error).toMatch(/disconnected/);
  });

  test("materialises a token with null expiresAt (no expiry info)", async () => {
    const conn = buildOAuthConnection({
      id: "conn-noexpiry",
      providerKey: "integration:github",
      expiresAt: null,
      hasRefreshToken: false,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:github", "conn-noexpiry");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-noexpiry")]: "gho_token123",
    });
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    // null expiresAt means isTokenExpired returns false, so the token is used as-is
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("gho_token123");
  });
});

// ---------------------------------------------------------------------------
// 6. Refresh-on-expiry
// ---------------------------------------------------------------------------

describe("OAuth refresh-on-expiry", () => {
  test("refreshes an expired token and returns the new access token", async () => {
    const conn = buildOAuthConnection({
      id: "conn-expired",
      providerKey: "integration:google",
      // Token expired 10 minutes ago
      expiresAt: Date.now() - 10 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:google", "conn-expired");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-expired")]: "old-expired-token",
      [oauthConnectionRefreshTokenPath("conn-expired")]: "refresh-token-abc",
    });

    const refreshFn: TokenRefreshFn = async (_connId, _refreshToken) => {
      return {
        success: true,
        accessToken: "ya29.new-refreshed-token",
        expiresAt: Date.now() + 3600 * 1000,
      };
    };

    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
      tokenRefreshFn: refreshFn,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("ya29.new-refreshed-token");
    expect(result.credential.handleType).toBe(HandleType.LocalOAuth);
  });

  test("fails when token is expired but no refresh function is configured", async () => {
    const conn = buildOAuthConnection({
      id: "conn-no-refresh-fn",
      providerKey: "integration:google",
      expiresAt: Date.now() - 10 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:google", "conn-no-refresh-fn");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-no-refresh-fn")]: "old-token",
      [oauthConnectionRefreshTokenPath("conn-no-refresh-fn")]: "refresh-tok",
    });

    // No tokenRefreshFn provided
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/expired/);
    expect(result.error).toMatch(/no refresh.*function/i);
  });

  test("fails when token is expired and no refresh token is stored", async () => {
    const conn = buildOAuthConnection({
      id: "conn-no-stored-refresh",
      providerKey: "integration:google",
      expiresAt: Date.now() - 10 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle(
      "integration:google",
      "conn-no-stored-refresh",
    );

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Access token exists but refresh token does not
    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-no-stored-refresh")]: "old-token",
      // No refresh token entry
    });

    const refreshFn: TokenRefreshFn = async () => {
      throw new Error("Should not be called");
    };

    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
      tokenRefreshFn: refreshFn,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/expired/);
    expect(result.error).toMatch(/no refresh.*token.*available/i);
  });

  test("fails when refresh function returns a failure result", async () => {
    const conn = buildOAuthConnection({
      id: "conn-refresh-fail",
      providerKey: "integration:google",
      expiresAt: Date.now() - 10 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle(
      "integration:google",
      "conn-refresh-fail",
    );

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-refresh-fail")]: "old-token",
      [oauthConnectionRefreshTokenPath("conn-refresh-fail")]: "refresh-tok",
    });

    const refreshFn: TokenRefreshFn = async () => {
      return { success: false, error: "Token has been revoked by user" };
    };

    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
      tokenRefreshFn: refreshFn,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Failed to refresh/);
    expect(result.error).toMatch(/revoked/);
  });
});

// ---------------------------------------------------------------------------
// 7. Circuit breaker
// ---------------------------------------------------------------------------

describe("refresh circuit breaker", () => {
  test("trips after repeated refresh failures and returns error", async () => {
    const conn = buildOAuthConnection({
      id: "conn-breaker",
      providerKey: "integration:google",
      expiresAt: Date.now() - 10 * 60 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:google", "conn-breaker");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-breaker")]: "old-token",
      [oauthConnectionRefreshTokenPath("conn-breaker")]: "refresh-tok",
    });

    let callCount = 0;
    const refreshFn: TokenRefreshFn = async () => {
      callCount++;
      return { success: false, error: "Provider rejected refresh" };
    };

    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
      tokenRefreshFn: refreshFn,
    });

    // Exhaust the circuit breaker threshold
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      const result = await materialiser.materialise(resolved.subject);
      expect(result.ok).toBe(false);
    }

    // The next attempt should be blocked by the circuit breaker
    const blockedResult = await materialiser.materialise(resolved.subject);
    expect(blockedResult.ok).toBe(false);
    if (blockedResult.ok) return;
    expect(blockedResult.error).toMatch(/circuit breaker/i);

    // The refresh function should NOT have been called for the blocked attempt
    expect(callCount).toBe(REFRESH_FAILURE_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// 8. Deterministic failure before outbound work
// ---------------------------------------------------------------------------

describe("deterministic fail-closed behaviour", () => {
  test("all resolution failures happen synchronously before materialisation", () => {
    const deps = createResolverDeps({});

    // Invalid handle format
    const r1 = resolveLocalSubject("not-a-handle", deps);
    expect(r1.ok).toBe(false);

    // Missing static credential
    const r2 = resolveLocalSubject(localStaticHandle("missing", "key"), deps);
    expect(r2.ok).toBe(false);

    // Missing OAuth connection
    const r3 = resolveLocalSubject(
      localOAuthHandle("integration:x", "missing-conn"),
      deps,
    );
    expect(r3.ok).toBe(false);

    // Platform handle in local resolver
    const r4 = resolveLocalSubject(platformOAuthHandle("plat-conn"), deps);
    expect(r4.ok).toBe(false);

    // All failures are deterministic, synchronous, and happen before
    // any async materialisation (network call, command launch) is attempted.
  });

  test("materialisation failures for missing keys are deterministic", async () => {
    const record = buildStaticRecord({
      service: "aws",
      field: "secret_key",
    });
    const deps = createResolverDeps({ staticRecords: [record] });
    const handle = localStaticHandle("aws", "secret_key");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const backend = createMemoryBackend({}); // Empty — key not stored
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Error happens before any network call could be made
    expect(result.error).toMatch(/not found/);
  });

  test("OAuth disconnection detected before any refresh attempt", async () => {
    const conn = buildOAuthConnection({
      id: "conn-disco",
      providerKey: "integration:slack",
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:slack", "conn-disco");

    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // No access token stored
    const backend = createMemoryBackend({});
    let refreshCalled = false;
    const refreshFn: TokenRefreshFn = async () => {
      refreshCalled = true;
      return { success: true, accessToken: "tok", expiresAt: null };
    };

    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
      tokenRefreshFn: refreshFn,
    });

    const result = await materialiser.materialise(resolved.subject);

    expect(result.ok).toBe(false);
    // Refresh function should NOT have been called
    expect(refreshCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. End-to-end resolution + materialisation
// ---------------------------------------------------------------------------

describe("end-to-end local materialisation", () => {
  test("full pipeline: resolve static handle -> materialise secret", async () => {
    const record = buildStaticRecord({
      service: "openai",
      field: "api_key",
    });
    const deps = createResolverDeps({ staticRecords: [record] });
    const handle = localStaticHandle("openai", "api_key");

    // Step 1: Resolve
    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Step 2: Materialise
    const backend = createMemoryBackend({
      "credential/openai/api_key": "sk-live-abc123",
    });
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("sk-live-abc123");
    expect(result.credential.handleType).toBe(HandleType.LocalStatic);
  });

  test("full pipeline: resolve OAuth handle -> materialise token", async () => {
    const conn = buildOAuthConnection({
      id: "conn-e2e",
      providerKey: "integration:linear",
      expiresAt: Date.now() + 3600 * 1000,
      hasRefreshToken: true,
    });
    const deps = createResolverDeps({ oauthConnections: [conn] });
    const handle = localOAuthHandle("integration:linear", "conn-e2e");

    // Step 1: Resolve
    const resolved = resolveLocalSubject(handle, deps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Step 2: Materialise
    const backend = createMemoryBackend({
      [oauthConnectionAccessTokenPath("conn-e2e")]: "lin_api_token_xyz",
    });
    const materialiser = new LocalMaterialiser({
      secureKeyBackend: backend,
    });

    const result = await materialiser.materialise(resolved.subject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.value).toBe("lin_api_token_xyz");
    expect(result.credential.handleType).toBe(HandleType.LocalOAuth);
  });
});
