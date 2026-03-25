/**
 * Tests for managed OAuth subject resolution and materialization.
 *
 * Covers:
 * 1. Successful subject resolution from platform catalog
 * 2. Platform HTTP error handling (401, 403, 404, 5xx)
 * 3. Successful token materialization
 * 4. Expired token refresh via platform re-materialization
 * 5. Missing assistant API key behavior
 * 6. Fail-closed behavior when platform is unreachable
 * 7. Uniform subject shape between local and managed handles
 * 8. Materialized tokens are never persisted
 */

import { describe, expect, test } from "bun:test";

import { platformOAuthHandle } from "@vellumai/ces-contracts";

import {
  type ManagedSubject,
  resolveManagedSubject,
  SubjectResolutionError,
  type PlatformCatalogEntry,
  type ResolvedSubject,
} from "../subjects/managed.js";
import {
  materializeManagedToken,
  MaterializationError,
  type ManagedMaterializerOptions,
} from "../materializers/managed-platform.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PLATFORM_URL = "https://api.test-platform.vellum.ai";
const TEST_API_KEY = "test-api-key-abc123";
const TEST_ASSISTANT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/**
 * Build a mock catalog response matching the platform's flat-array format.
 * The platform serializes with many=True, returning a JSON array directly.
 */
function buildCatalogResponse(
  entries: PlatformCatalogEntry[],
): PlatformCatalogEntry[] {
  return entries;
}

/**
 * Build a mock platform token response matching
 * ManagedTokenMaterializeResponseSerializer.
 */
function buildTokenResponse(overrides: {
  access_token?: string;
  token_type?: string;
  expires_at?: string | null;
  provider?: string;
  handle?: string;
} = {}) {
  return {
    access_token: overrides.access_token ?? "mat_token_abc123",
    token_type: overrides.token_type ?? "Bearer",
    expires_at: overrides.expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
    provider: overrides.provider ?? "google",
    handle: overrides.handle ?? "platform_oauth:conn_test123",
  };
}

/**
 * Create a mock fetch that responds based on URL path.
 */
function createMockFetch(handlers: {
  catalog?: {
    status: number;
    body?: unknown;
    error?: Error;
  };
  materialize?: {
    status: number;
    body?: unknown;
    error?: Error;
  };
}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/oauth/managed/catalog")) {
      if (handlers.catalog?.error) {
        throw handlers.catalog.error;
      }
      return new Response(
        JSON.stringify(handlers.catalog?.body ?? []),
        {
          status: handlers.catalog?.status ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.includes("/oauth/managed/materialize")) {
      if (handlers.materialize?.error) {
        throw handlers.materialize.error;
      }
      return new Response(
        JSON.stringify(handlers.materialize?.body ?? buildTokenResponse()),
        {
          status: handlers.materialize?.status ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
}

/**
 * Build a managed subject for materialization tests.
 */
function buildManagedSubject(
  overrides: Partial<ManagedSubject> = {},
): ManagedSubject {
  return {
    source: "managed",
    handle: platformOAuthHandle("conn_test123"),
    provider: "google",
    connectionId: "conn_test123",
    accountInfo: "user@example.com",
    grantedScopes: ["email", "calendar"],
    status: "active",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful subject resolution
// ---------------------------------------------------------------------------

describe("resolveManagedSubject", () => {
  test("resolves a valid platform_oauth handle from the catalog", async () => {
    const handle = platformOAuthHandle("conn_abc123");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          {
            handle: "platform_oauth:conn_abc123",
            connection_id: "conn_abc123",
            provider: "google",
            account_label: "user@example.com",
            scopes_granted: ["email", "calendar"],
            status: "active",
          },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.subject.source).toBe("managed");
    expect(result.subject.handle).toBe(handle);
    expect(result.subject.provider).toBe("google");
    expect(result.subject.connectionId).toBe("conn_abc123");
    expect(result.subject.accountInfo).toBe("user@example.com");
    expect(result.subject.grantedScopes).toEqual(["email", "calendar"]);
    expect(result.subject.status).toBe("active");
  });

  test("resolves a handle when catalog has multiple connections", async () => {
    const handle = platformOAuthHandle("conn_second");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          { handle: "platform_oauth:conn_first", connection_id: "conn_first", provider: "slack" },
          {
            handle: "platform_oauth:conn_second",
            connection_id: "conn_second",
            provider: "github",
            account_label: "dev@github.com",
            scopes_granted: ["repo", "read:org"],
            status: "active",
          },
          { handle: "platform_oauth:conn_third", connection_id: "conn_third", provider: "google" },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject.provider).toBe("github");
    expect(result.subject.connectionId).toBe("conn_second");
  });

  test("defaults account_info to null and granted_scopes to empty array", async () => {
    const handle = platformOAuthHandle("conn_minimal");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          { handle: "platform_oauth:conn_minimal", connection_id: "conn_minimal", provider: "slack" },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject.accountInfo).toBeNull();
    expect(result.subject.grantedScopes).toEqual([]);
    expect(result.subject.status).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Handle validation
  // -------------------------------------------------------------------------

  test("rejects an invalid handle format", async () => {
    const result = await resolveManagedSubject("not-a-valid-handle", {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_HANDLE");
  });

  test("rejects a local_static handle", async () => {
    const result = await resolveManagedSubject("local_static:github/api_key", {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("WRONG_HANDLE_TYPE");
    expect(result.error.message).toContain("local_static");
  });

  test("rejects a local_oauth handle", async () => {
    const result = await resolveManagedSubject(
      "local_oauth:google/conn_local1",
      {
        platformBaseUrl: TEST_PLATFORM_URL,
        assistantApiKey: TEST_API_KEY,
        assistantId: TEST_ASSISTANT_ID,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("WRONG_HANDLE_TYPE");
    expect(result.error.message).toContain("local_oauth");
  });

  // -------------------------------------------------------------------------
  // Connection not found in catalog
  // -------------------------------------------------------------------------

  test("returns error when connection is not in the catalog", async () => {
    const handle = platformOAuthHandle("conn_nonexistent");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          { handle: "platform_oauth:conn_other", connection_id: "conn_other", provider: "slack" },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONNECTION_NOT_FOUND");
    expect(result.error.message).toContain("conn_nonexistent");
  });

  // -------------------------------------------------------------------------
  // Platform HTTP errors
  // -------------------------------------------------------------------------

  test("handles platform 401 (invalid API key)", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: { status: 401 },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_HTTP_401");
    expect(result.error.message).toContain("401");
  });

  test("handles platform 403 (forbidden)", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: { status: 403 },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_HTTP_403");
  });

  test("handles platform 404 (catalog not found)", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: { status: 404 },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_HTTP_404");
  });

  test("handles platform 500 (server error)", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: { status: 500 },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_HTTP_500");
  });

  // -------------------------------------------------------------------------
  // Missing prerequisites
  // -------------------------------------------------------------------------

  test("fails when assistant API key is missing", async () => {
    const handle = platformOAuthHandle("conn_test");

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: "",
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_API_KEY");
  });

  test("fails when platform base URL is missing", async () => {
    const handle = platformOAuthHandle("conn_test");

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: "",
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_PLATFORM_URL");
  });

  test("fails when assistant ID is missing", async () => {
    const handle = platformOAuthHandle("conn_test");

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_ASSISTANT_ID");
  });

  // -------------------------------------------------------------------------
  // Fail-closed behavior (network errors)
  // -------------------------------------------------------------------------

  test("fails closed when platform is unreachable", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: {
        status: 0,
        error: new Error("ECONNREFUSED: Connection refused"),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_UNREACHABLE");
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  test("sanitizes API key from network error messages", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: {
        status: 0,
        error: new Error(
          `Failed to connect with Api-Key ${TEST_API_KEY} header`,
        ),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(TEST_API_KEY);
    expect(result.error.message).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // Invalid catalog response format
  // -------------------------------------------------------------------------

  test("handles catalog response with missing connections field", async () => {
    const handle = platformOAuthHandle("conn_test");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: { data: [] }, // wrong shape
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CATALOG_RESPONSE");
  });
});

// ---------------------------------------------------------------------------
// 2. Managed token materialization
// ---------------------------------------------------------------------------

describe("materializeManagedToken", () => {
  test("materializes a token successfully", async () => {
    const subject = buildManagedSubject();
    const futureExpiry = new Date(Date.now() + 1_800_000).toISOString();
    const mockFetch = createMockFetch({
      materialize: {
        status: 200,
        body: buildTokenResponse({
          access_token: "fresh_token_xyz",
          expires_at: futureExpiry,
        }),
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.token.accessToken).toBe("fresh_token_xyz");
    expect(result.token.tokenType).toBe("Bearer");
    expect(result.token.provider).toBe("google");
    expect(result.token.connectionId).toBe("conn_test123");
    // expires_at is parsed from ISO datetime
    expect(result.token.expiresAt).not.toBeNull();
    const expectedMs = new Date(futureExpiry).getTime();
    expect(result.token.expiresAt!).toBe(expectedMs);
  });

  test("defaults token_type to Bearer when not provided", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: {
        status: 200,
        body: { access_token: "tok_no_type", expires_at: null },
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.tokenType).toBe("Bearer");
    expect(result.token.expiresAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Platform error responses during materialization
  // -------------------------------------------------------------------------

  test("handles platform 401 during materialization", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: { status: 401 },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_AUTH_FAILED");
    expect(result.error.message).toContain("401");
  });

  test("handles platform 403 during materialization", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: { status: 403 },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_FORBIDDEN");
  });

  test("handles platform 404 during materialization", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: { status: 404 },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONNECTION_NOT_FOUND");
    expect(result.error.message).toContain("conn_test123");
  });

  test("handles platform 500 during materialization", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: { status: 500 },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_HTTP_500");
  });

  // -------------------------------------------------------------------------
  // Missing prerequisites
  // -------------------------------------------------------------------------

  test("fails when assistant API key is missing", async () => {
    const subject = buildManagedSubject();

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: "",
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_API_KEY");
  });

  test("fails when platform base URL is missing", async () => {
    const subject = buildManagedSubject();

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: "",
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_PLATFORM_URL");
  });

  test("fails when assistant ID is missing", async () => {
    const subject = buildManagedSubject();

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_ASSISTANT_ID");
  });

  // -------------------------------------------------------------------------
  // Fail-closed (network errors)
  // -------------------------------------------------------------------------

  test("fails closed when platform is unreachable during materialization", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: {
        status: 0,
        error: new Error("ETIMEDOUT: Connection timed out"),
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLATFORM_UNREACHABLE");
    expect(result.error.message).toContain("ETIMEDOUT");
  });

  test("sanitizes API key from materialization error messages", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: {
        status: 0,
        error: new Error(
          `Request failed with Api-Key ${TEST_API_KEY}`,
        ),
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(TEST_API_KEY);
    expect(result.error.message).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // Invalid token response
  // -------------------------------------------------------------------------

  test("handles response with missing access_token", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: {
        status: 200,
        body: { token_type: "Bearer", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_TOKEN_RESPONSE");
    expect(result.error.message).toContain("access_token");
  });

  // -------------------------------------------------------------------------
  // Expired token refresh via re-materialization
  // -------------------------------------------------------------------------

  test("re-materialization after expiry returns a fresh token", async () => {
    const subject = buildManagedSubject();
    let callCount = 0;

    const mockFetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      callCount++;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth/managed/materialize")) {
        // Each call returns a different token to prove we got a fresh one
        return Promise.resolve(
          new Response(
            JSON.stringify(
              buildTokenResponse({
                access_token: `fresh_token_${callCount}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              }),
            ),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const opts: ManagedMaterializerOptions = {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    };

    // First materialization
    const result1 = await materializeManagedToken(subject, opts);
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.token.accessToken).toBe("fresh_token_1");

    // Simulate expiry by re-materializing (in the real system, CES would
    // check expiresAt and call materialize again)
    const result2 = await materializeManagedToken(subject, opts);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.token.accessToken).toBe("fresh_token_2");
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Uniform subject interface
// ---------------------------------------------------------------------------

describe("uniform subject interface", () => {
  test("managed subject conforms to ResolvedSubject interface", async () => {
    const handle = platformOAuthHandle("conn_uniform");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          {
            handle: "platform_oauth:conn_uniform",
            connection_id: "conn_uniform",
            provider: "github",
            account_label: "dev@example.com",
            scopes_granted: ["repo"],
            status: "active",
          },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the managed subject can be treated as a ResolvedSubject
    const subject: ResolvedSubject = result.subject;
    expect(subject.source).toBe("managed");
    expect(subject.handle).toBe(handle);
    expect(subject.provider).toBe("github");
    expect(subject.connectionId).toBe("conn_uniform");
  });

  test("managed subject has 'managed' source for branching", async () => {
    const handle = platformOAuthHandle("conn_branch");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          { handle: "platform_oauth:conn_branch", connection_id: "conn_branch", provider: "slack" },
        ]),
      },
    });

    const result = await resolveManagedSubject(handle, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // CES execution paths can branch on source without casting
    const subject: ResolvedSubject = result.subject;
    switch (subject.source) {
      case "managed":
        // Managed path — materialize via platform
        expect(true).toBe(true);
        break;
      case "local":
        // Local path — should not reach here
        expect(true).toBe(false);
        break;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Token non-persistence invariant
// ---------------------------------------------------------------------------

describe("token non-persistence invariant", () => {
  test("materialized token is returned in-memory only — no disk writes", async () => {
    const subject = buildManagedSubject();
    const mockFetch = createMockFetch({
      materialize: {
        status: 200,
        body: buildTokenResponse({ access_token: "ephemeral_token" }),
      },
    });

    const result = await materializeManagedToken(subject, {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The MaterializedToken type has no persist/save methods —
    // it is a plain data object. Verify it is a simple object.
    expect(typeof result.token.accessToken).toBe("string");
    expect(typeof result.token.tokenType).toBe("string");
    expect(typeof result.token.provider).toBe("string");
    expect(typeof result.token.connectionId).toBe("string");

    // Verify no reference to storage backends, file paths, or persist calls
    const tokenKeys = Object.keys(result.token);
    expect(tokenKeys).toEqual([
      "accessToken",
      "tokenType",
      "expiresAt",
      "provider",
      "connectionId",
    ]);
  });

  test("materializer source code does not import credential-storage", async () => {
    // Static verification: the materializer must not import from
    // @vellumai/credential-storage, which would indicate it might
    // persist tokens locally.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const src = readFileSync(
      resolve(__dirname, "..", "materializers", "managed-platform.ts"),
      "utf-8",
    );

    expect(src).not.toContain("credential-storage");
    expect(src).not.toContain("writeFile");
    expect(src).not.toContain("SecureKeyBackend");
    expect(src).not.toContain("persistOAuthTokens");
  });

  test("subject resolver source code does not import credential-storage", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const src = readFileSync(
      resolve(__dirname, "..", "subjects", "managed.ts"),
      "utf-8",
    );

    expect(src).not.toContain("credential-storage");
    expect(src).not.toContain("SecureKeyBackend");
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end resolve + materialize
// ---------------------------------------------------------------------------

describe("end-to-end resolve and materialize", () => {
  test("resolves a handle and then materializes a token", async () => {
    const handle = platformOAuthHandle("conn_e2e");
    const mockFetch = createMockFetch({
      catalog: {
        status: 200,
        body: buildCatalogResponse([
          {
            handle: "platform_oauth:conn_e2e",
            connection_id: "conn_e2e",
            provider: "google",
            account_label: "e2e@example.com",
            scopes_granted: ["drive"],
            status: "active",
          },
        ]),
      },
      materialize: {
        status: 200,
        body: buildTokenResponse({
          access_token: "e2e_access_token",
          expires_at: new Date(Date.now() + 7200_000).toISOString(),
        }),
      },
    });

    const opts = {
      platformBaseUrl: TEST_PLATFORM_URL,
      assistantApiKey: TEST_API_KEY,
      assistantId: TEST_ASSISTANT_ID,
      fetch: mockFetch,
    };

    // Phase 1: Resolve
    const resolveResult = await resolveManagedSubject(handle, opts);
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    // Phase 2: Materialize using the resolved subject
    const matResult = await materializeManagedToken(
      resolveResult.subject,
      opts,
    );
    expect(matResult.ok).toBe(true);
    if (!matResult.ok) return;

    expect(matResult.token.accessToken).toBe("e2e_access_token");
    expect(matResult.token.provider).toBe("google");
    expect(matResult.token.connectionId).toBe("conn_e2e");
  });
});
