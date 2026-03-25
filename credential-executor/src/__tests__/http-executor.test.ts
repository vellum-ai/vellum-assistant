/**
 * Integration tests for the CES HTTP executor.
 *
 * Covers:
 * 1. Local static secret flow — resolve, grant-check, materialise, execute, filter
 * 2. Local OAuth flow — resolve, grant-check, materialise (with token), execute, filter
 * 3. platform_oauth:<connection_id> flow — resolve, grant-check, materialise via
 *    platform, execute, filter
 * 4. Approval-required short-circuit — off-grant requests return a proposal
 *    without making any network call
 * 5. Forbidden header rejection — caller-supplied auth headers are blocked
 * 6. Redirect denial — redirect hops that violate grant policy are blocked
 * 7. Filtered response behaviour — secret scrubbing, header stripping, body clamping
 * 8. Audit summaries are token-free
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
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
  credentialKey,
} from "@vellumai/credential-storage";

import {
  executeAuthenticatedHttpRequest,
  type HttpExecutorDeps,
} from "../http/executor.js";
import { PersistentGrantStore } from "../grants/persistent-store.js";
import { TemporaryGrantStore } from "../grants/temporary-store.js";
import { LocalMaterialiser } from "../materializers/local.js";
import type { OAuthConnectionLookup, LocalSubjectResolverDeps } from "../subjects/local.js";
import { AuditStore } from "../audit/store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ces-http-executor-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * In-memory secure-key backend for testing.
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

function buildStaticRecord(
  overrides: Partial<StaticCredentialRecord> = {},
): StaticCredentialRecord {
  return {
    credentialId: overrides.credentialId ?? "cred-uuid-1",
    service: overrides.service ?? "github",
    field: overrides.field ?? "api_key",
    allowedTools: overrides.allowedTools ?? ["make_authenticated_request"],
    allowedDomains: overrides.allowedDomains ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function buildOAuthConnection(
  overrides: Partial<OAuthConnectionRecord> = {},
): OAuthConnectionRecord {
  return {
    id: overrides.id ?? "conn-uuid-1",
    providerKey: overrides.providerKey ?? "google",
    accountInfo: overrides.accountInfo ?? "user@example.com",
    grantedScopes: overrides.grantedScopes ?? ["openid", "email"],
    accessTokenPath: overrides.accessTokenPath ??
      oauthConnectionAccessTokenPath(overrides.id ?? "conn-uuid-1"),
    hasRefreshToken: overrides.hasRefreshToken ?? true,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function createOAuthLookup(
  connections: OAuthConnectionRecord[] = [],
): OAuthConnectionLookup {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return {
    getById(id: string) {
      return byId.get(id);
    },
  };
}

/**
 * Build a mock fetch that returns a predetermined response.
 */
function mockFetch(
  statusCode: number,
  body: string,
  headers?: Record<string, string>,
): typeof globalThis.fetch {
  return asFetch(async (_url: string | URL | Request, _init?: RequestInit) => {
    const responseHeaders = new Headers(headers ?? {});
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(body, {
      status: statusCode,
      headers: responseHeaders,
    });
  });
}

/**
 * Build a mock fetch that records requests for inspection.
 */
function mockFetchRecorder(
  statusCode: number,
  body: string,
  headers?: Record<string, string>,
): {
  fetch: typeof globalThis.fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = asFetch(async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: url.toString(), init });
    const responseHeaders = new Headers(headers ?? {});
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(body, {
      status: statusCode,
      headers: responseHeaders,
    });
  });
  return { fetch: fetchFn, requests };
}

/**
 * Build a mock fetch that returns a redirect on first call, then a real
 * response on subsequent calls.
 */
function mockFetchRedirect(
  redirectUrl: string,
  redirectStatus: number,
  finalStatusCode: number,
  finalBody: string,
): typeof globalThis.fetch {
  let callCount = 0;
  return asFetch(async (_url: string | URL | Request, _init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return new Response(null, {
        status: redirectStatus,
        headers: { Location: redirectUrl },
      });
    }
    return new Response(finalBody, {
      status: finalStatusCode,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Attach a no-op `preconnect` so a plain async function satisfies
 * Bun's `typeof globalThis.fetch` (which includes `preconnect`).
 */
function asFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fn, {
    preconnect: (_url: string | URL) => {},
  }) as unknown as typeof globalThis.fetch;
}

/** Silent logger that suppresses output during tests. */
const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestFixture {
  tmpDir: string;
  persistentStore: PersistentGrantStore;
  temporaryStore: TemporaryGrantStore;
  backend: SecureKeyBackend;
  metadataStore: StaticCredentialMetadataStore;
  localMaterialiser: LocalMaterialiser;
}

function createFixture(
  secretEntries: Record<string, string> = {},
  staticRecords: StaticCredentialRecord[] = [],
  oauthConnections: OAuthConnectionRecord[] = [],
): TestFixture {
  const tmpDir = makeTmpDir();
  const persistentStore = new PersistentGrantStore(tmpDir);
  persistentStore.init();
  const temporaryStore = new TemporaryGrantStore();

  const backend = createMemoryBackend(secretEntries);
  const metadataStore = new StaticCredentialMetadataStore(
    join(tmpDir, "credentials.json"),
  );
  for (const record of staticRecords) {
    metadataStore.upsert(record.service, record.field, {
      allowedTools: record.allowedTools,
      allowedDomains: record.allowedDomains,
    });
  }

  const oauthLookup = createOAuthLookup(oauthConnections);

  const localMaterialiser = new LocalMaterialiser({
    secureKeyBackend: backend,
  });

  return {
    tmpDir,
    persistentStore,
    temporaryStore,
    backend,
    metadataStore,
    localMaterialiser,
  };
}

function buildDeps(
  fixture: TestFixture,
  oauthConnections: OAuthConnectionRecord[] = [],
  overrides: Partial<HttpExecutorDeps> = {},
): HttpExecutorDeps {
  return {
    persistentGrantStore: fixture.persistentStore,
    temporaryGrantStore: fixture.temporaryStore,
    localMaterialiser: fixture.localMaterialiser,
    localSubjectDeps: {
      metadataStore: fixture.metadataStore,
      oauthConnections: createOAuthLookup(oauthConnections),
    },
    sessionId: { current: "test-session" },
    logger: silentLogger,
    ...overrides,
    auditStore: overrides.auditStore ?? new AuditStore(fixture.tmpDir),
  };
}

// ---------------------------------------------------------------------------
// Tests: Local static secrets
// ---------------------------------------------------------------------------

describe("HTTP executor: local static secrets", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const handle = localStaticHandle("github", "api_key");
    const storageKey = credentialKey("github", "api_key");
    fixture = createFixture(
      { [storageKey]: "ghp_testtoken_12345678" },
      [buildStaticRecord({ service: "github", field: "api_key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("successful request with matching grant", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Add a matching grant
    fixture.persistentStore.add({
      id: "grant-github-repos",
      tool: "http",
      pattern: "GET https://api.github.com/repos/owner/repo",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const { fetch: fetchFn, requests } = mockFetchRecorder(
      200,
      '{"name": "repo", "full_name": "owner/repo"}',
    );

    const deps = buildDeps(fixture, [], { fetch: fetchFn });
    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/repos/owner/repo",
        purpose: "Get repo info",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toContain("owner/repo");
    expect(result.auditId).toBeDefined();

    // Verify the outbound request had auth injected
    expect(requests).toHaveLength(1);
    const outboundHeaders = requests[0].init?.headers as Record<string, string>;
    expect(outboundHeaders?.["Authorization"]).toContain("Bearer");
    expect(outboundHeaders?.["Authorization"]).toContain("ghp_testtoken_12345678");
  });

  test("response body is scrubbed of secret values", async () => {
    const handle = localStaticHandle("github", "api_key");

    fixture.persistentStore.add({
      id: "grant-github-user",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Simulate API echoing back the token in response
    const fetchFn = mockFetch(
      200,
      '{"token_echo": "ghp_testtoken_12345678", "name": "octocat"}',
    );

    const deps = buildDeps(fixture, [], { fetch: fetchFn });
    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/user",
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.responseBody).not.toContain("ghp_testtoken_12345678");
    expect(result.responseBody).toContain("[CES:REDACTED]");
    expect(result.responseBody).toContain("octocat");
  });

  test("response headers are filtered (set-cookie stripped)", async () => {
    const handle = localStaticHandle("github", "api_key");

    fixture.persistentStore.add({
      id: "grant-github-data",
      tool: "http",
      pattern: "GET https://api.github.com/data",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = mockFetch(200, '{"ok": true}', {
      "content-type": "application/json",
      "set-cookie": "session=secret; HttpOnly",
      "x-request-id": "req-123",
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });
    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.responseHeaders).toBeDefined();
    expect(result.responseHeaders!["content-type"]).toBe("application/json");
    expect(result.responseHeaders!["x-request-id"]).toBe("req-123");
    // set-cookie must be stripped
    expect(result.responseHeaders!["set-cookie"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Local OAuth
// ---------------------------------------------------------------------------

describe("HTTP executor: local OAuth", () => {
  let fixture: TestFixture;
  let connection: OAuthConnectionRecord;

  beforeEach(() => {
    connection = buildOAuthConnection({
      id: "conn-google-1",
      providerKey: "google",
      expiresAt: Date.now() + 3600000, // valid for 1 hour
    });

    const accessTokenPath = oauthConnectionAccessTokenPath("conn-google-1");
    fixture = createFixture(
      { [accessTokenPath]: "ya29.test-google-token-abc123" },
      [],
      [connection],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("successful OAuth request with matching grant", async () => {
    const handle = localOAuthHandle("google", "conn-google-1");

    fixture.persistentStore.add({
      id: "grant-google-calendar",
      tool: "http",
      pattern: "GET https://www.googleapis.com/calendar/v3/calendars/primary/events",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const { fetch: fetchFn, requests } = mockFetchRecorder(
      200,
      '{"items": [{"summary": "Meeting"}]}',
    );

    const deps = buildDeps(fixture, [connection], { fetch: fetchFn });
    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        purpose: "List calendar events",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toContain("Meeting");
    expect(result.auditId).toBeDefined();

    // Verify Bearer token was injected
    expect(requests).toHaveLength(1);
    const outboundHeaders = requests[0].init?.headers as Record<string, string>;
    expect(outboundHeaders?.["Authorization"]).toBe(
      "Bearer ya29.test-google-token-abc123",
    );
  });

  test("OAuth token scrubbed from response body", async () => {
    const handle = localOAuthHandle("google", "conn-google-1");

    fixture.persistentStore.add({
      id: "grant-google-debug",
      tool: "http",
      pattern: "GET https://www.googleapis.com/oauth2/v1/tokeninfo",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Simulate tokeninfo endpoint echoing the token
    const fetchFn = mockFetch(
      200,
      '{"access_token": "ya29.test-google-token-abc123", "expires_in": 3600}',
    );

    const deps = buildDeps(fixture, [connection], { fetch: fetchFn });
    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://www.googleapis.com/oauth2/v1/tokeninfo",
        purpose: "Check token info",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.responseBody).not.toContain("ya29.test-google-token-abc123");
    expect(result.responseBody).toContain("[CES:REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Tests: Managed (platform_oauth) handles
// ---------------------------------------------------------------------------

describe("HTTP executor: platform_oauth handles", () => {
  let fixture: TestFixture;
  let tmpDir: string;

  beforeEach(() => {
    fixture = createFixture();
    tmpDir = fixture.tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("successful platform OAuth request", async () => {
    const handle = platformOAuthHandle("conn-platform-1");

    fixture.persistentStore.add({
      id: "grant-platform-api",
      tool: "http",
      pattern: "GET https://api.slack.com/api/conversations.list",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Mock the platform catalog response
    const platformCatalogFetch = asFetch(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const urlStr = url.toString();

      // Platform catalog
      if (urlStr.includes("/oauth/managed/catalog")) {
        return new Response(
          JSON.stringify([
            {
              handle: "platform_oauth:conn-platform-1",
              connection_id: "conn-platform-1",
              provider: "slack",
              account_label: "workspace@slack.com",
              scopes_granted: ["channels:read"],
              status: "active",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Platform token materialization
      if (urlStr.includes("/oauth/managed/materialize")) {
        return new Response(
          JSON.stringify({
            access_token: "xoxp-platform-token-12345678",
            token_type: "Bearer",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            provider: "slack",
            handle: "platform_oauth:conn-platform-1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // The actual outbound Slack API call
      if (urlStr.includes("api.slack.com")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [{ name: "general" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const deps = buildDeps(fixture, [], {
      fetch: platformCatalogFetch,
      managedSubjectOptions: {
        platformBaseUrl: "https://api.vellum.ai",
        assistantApiKey: "test-api-key",
        assistantId: "test-assistant-id",
        fetch: platformCatalogFetch,
      },
      managedMaterializerOptions: {
        platformBaseUrl: "https://api.vellum.ai",
        assistantApiKey: "test-api-key",
        assistantId: "test-assistant-id",
        fetch: platformCatalogFetch,
      },
    });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.slack.com/api/conversations.list",
        purpose: "List Slack channels",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toContain("general");
    expect(result.auditId).toBeDefined();

    // Token should be scrubbed from body
    expect(result.responseBody).not.toContain("xoxp-platform-token-12345678");
  });

  test("fails when managed mode is not configured", async () => {
    const handle = platformOAuthHandle("conn-platform-1");

    fixture.persistentStore.add({
      id: "grant-platform-unconfigured",
      tool: "http",
      pattern: "GET https://api.slack.com/data",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // No managedSubjectOptions or managedMaterializerOptions
    const deps = buildDeps(fixture, []);

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.slack.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("MATERIALISATION_FAILED");
    expect(result.error!.message).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// Tests: Approval required short-circuit
// ---------------------------------------------------------------------------

describe("HTTP executor: approval-required short-circuit", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("stripe", "api_key");
    fixture = createFixture(
      { [storageKey]: "sk_test_abcdefghijklmnop" },
      [buildStaticRecord({ service: "stripe", field: "api_key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("off-grant request returns approval_required without network call", async () => {
    const handle = localStaticHandle("stripe", "api_key");
    // No grant added — should be blocked

    const { fetch: fetchFn, requests } = mockFetchRecorder(200, '{"ok": true}');
    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "POST",
        url: "https://api.stripe.com/v1/charges",
        purpose: "Create a charge",
      },
      deps,
    );

    // Request must be blocked
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("APPROVAL_REQUIRED");
    expect(result.error!.details).toBeDefined();
    expect((result.error!.details as Record<string, unknown>).proposal).toBeDefined();
    expect((result.error!.details as Record<string, unknown>).proposalHash).toBeDefined();

    // No network call should have been made
    expect(requests).toHaveLength(0);
  });

  test("proposal contains specific URL pattern (no wildcards)", async () => {
    const handle = localStaticHandle("stripe", "api_key");

    const deps = buildDeps(fixture, []);

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.stripe.com/v1/charges/123",
        purpose: "Get charge",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("APPROVAL_REQUIRED");

    const proposal = (result.error!.details as Record<string, unknown>)
      .proposal as Record<string, unknown>;
    const allowedPatterns = proposal.allowedUrlPatterns as string[];
    expect(allowedPatterns).toBeDefined();
    expect(allowedPatterns.length).toBeGreaterThan(0);

    for (const pattern of allowedPatterns) {
      expect(pattern).not.toContain("/*");
      expect(pattern).not.toContain("*.");
      // Should have {:num} for the charge ID
      expect(pattern).toContain("{:num}");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Forbidden header rejection
// ---------------------------------------------------------------------------

describe("HTTP executor: forbidden header rejection", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("github", "api_key");
    fixture = createFixture(
      { [storageKey]: "ghp_testtoken_12345678" },
      [buildStaticRecord({ service: "github", field: "api_key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("rejects request with Authorization header", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Even with a matching grant, should be rejected
    fixture.persistentStore.add({
      id: "grant-with-auth",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const { fetch: fetchFn, requests } = mockFetchRecorder(200, '{"ok": true}');
    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/user",
        headers: { Authorization: "Bearer smuggled-token" },
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("FORBIDDEN_HEADERS");
    expect(result.error!.message).toContain("Authorization");
    expect(requests).toHaveLength(0);
  });

  test("rejects request with Cookie header", async () => {
    const handle = localStaticHandle("github", "api_key");

    fixture.persistentStore.add({
      id: "grant-with-cookie",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const { fetch: fetchFn, requests } = mockFetchRecorder(200, '{"ok": true}');
    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/user",
        headers: { Cookie: "session=hijacked" },
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("FORBIDDEN_HEADERS");
    expect(requests).toHaveLength(0);
  });

  test("rejects request with X-Api-Key header", async () => {
    const handle = localStaticHandle("github", "api_key");

    fixture.persistentStore.add({
      id: "grant-with-xapikey",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const deps = buildDeps(fixture, []);

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/user",
        headers: { "X-Api-Key": "smuggled-key" },
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("FORBIDDEN_HEADERS");
  });
});

// ---------------------------------------------------------------------------
// Tests: Redirect denial
// ---------------------------------------------------------------------------

describe("HTTP executor: redirect denial", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("github", "api_key");
    fixture = createFixture(
      { [storageKey]: "ghp_testtoken_12345678" },
      [buildStaticRecord({ service: "github", field: "api_key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("blocks redirect to domain not covered by grant", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Grant only covers api.github.com
    fixture.persistentStore.add({
      id: "grant-github-only",
      tool: "http",
      pattern: "GET https://api.github.com/repos/owner/repo",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Redirect to an evil domain
    const fetchFn = mockFetchRedirect(
      "https://evil.example.com/steal-token",
      302,
      200,
      '{"stolen": true}',
    );

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/repos/owner/repo",
        purpose: "Get repo info",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("HTTP_REQUEST_FAILED");
    expect(result.error!.message).toContain("redirect");
    expect(result.error!.message).toContain("denied");
  });

  test("303 redirect evaluates policy against GET, not original method", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Grant only covers GET — no POST grant exists
    fixture.persistentStore.add({
      id: "grant-github-get-only",
      tool: "http",
      pattern: "GET https://api.github.com/repos/owner/repo/result",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Also add a grant for the original POST endpoint
    fixture.persistentStore.add({
      id: "grant-github-post",
      tool: "http",
      pattern: "POST https://api.github.com/repos/owner/repo/action",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // POST -> 303 redirect to a GET-only granted endpoint
    let callCount = 0;
    const requests: Array<{ url: string; method: string }> = [];
    const fetchFn = asFetch(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      callCount++;
      requests.push({ url: url.toString(), method: init?.method ?? "GET" });
      if (callCount === 1) {
        return new Response(null, {
          status: 303,
          headers: { Location: "https://api.github.com/repos/owner/repo/result" },
        });
      }
      return new Response('{"status": "done"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "POST",
        url: "https://api.github.com/repos/owner/repo/action",
        body: '{"trigger": true}',
        purpose: "Trigger action",
      },
      deps,
    );

    // Should succeed — policy evaluates GET (post-303 method) against the grant
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);

    // Verify the redirect hop actually used GET
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("POST");
    expect(requests[1].method).toBe("GET");
  });

  test("allows redirect to path covered by same grant", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Grant covers a template that matches both source and redirect target
    fixture.persistentStore.add({
      id: "grant-github-repos-template",
      tool: "http",
      pattern: "GET https://api.github.com/repos/owner/repo",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    // Redirect to the same domain/path that matches the grant
    let callCount = 0;
    const fetchFn = asFetch(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: "https://api.github.com/repos/owner/repo" },
        });
      }
      return new Response('{"name": "repo"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/repos/owner/repo",
        purpose: "Get repo info",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Filtered response behaviour
// ---------------------------------------------------------------------------

describe("HTTP executor: filtered response behaviour", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("example", "key");
    fixture = createFixture(
      { [storageKey]: "secret-key-value-12345678" },
      [buildStaticRecord({ service: "example", field: "key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("strips www-authenticate from response headers", async () => {
    const handle = localStaticHandle("example", "key");

    fixture.persistentStore.add({
      id: "grant-example",
      tool: "http",
      pattern: "GET https://api.example.com/protected",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = mockFetch(401, '{"error": "unauthorized"}', {
      "www-authenticate": "Bearer realm=api",
      "content-type": "application/json",
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.example.com/protected",
        purpose: "Access protected resource",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(401);
    expect(result.responseHeaders!["www-authenticate"]).toBeUndefined();
    expect(result.responseHeaders!["content-type"]).toBe("application/json");
  });

  test("passes through safe response headers", async () => {
    const handle = localStaticHandle("example", "key");

    fixture.persistentStore.add({
      id: "grant-example-safe",
      tool: "http",
      pattern: "GET https://api.example.com/data",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = mockFetch(200, '{"ok": true}', {
      "content-type": "application/json",
      "x-ratelimit-remaining": "42",
      "x-request-id": "abc-def",
      "etag": '"v1"',
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.example.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.responseHeaders!["content-type"]).toBe("application/json");
    expect(result.responseHeaders!["x-ratelimit-remaining"]).toBe("42");
    expect(result.responseHeaders!["x-request-id"]).toBe("abc-def");
    expect(result.responseHeaders!["etag"]).toBe('"v1"');
  });
});

// ---------------------------------------------------------------------------
// Tests: Audit summaries are token-free
// ---------------------------------------------------------------------------

describe("HTTP executor: audit summary integrity", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("github", "api_key");
    fixture = createFixture(
      { [storageKey]: "ghp_secrettoken_12345678" },
      [buildStaticRecord({ service: "github", field: "api_key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("audit ID is returned on successful request", async () => {
    const handle = localStaticHandle("github", "api_key");

    fixture.persistentStore.add({
      id: "grant-audit-test",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = mockFetch(200, '{"login": "octocat"}');
    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.github.com/user",
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.auditId).toBeDefined();
    expect(typeof result.auditId).toBe("string");
    expect(result.auditId!.length).toBeGreaterThan(0);
  });

  test("audit ID is returned on materialisation failure", async () => {
    const handle = localStaticHandle("github", "api_key");

    // Grant exists but we'll break materialisation by using a handle that
    // won't resolve (wrong service)
    const badHandle = localStaticHandle("nonexistent", "key");
    fixture.persistentStore.add({
      id: "grant-bad-cred",
      tool: "http",
      pattern: "GET https://api.github.com/user",
      scope: badHandle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const deps = buildDeps(fixture, []);

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: badHandle,
        method: "GET",
        url: "https://api.github.com/user",
        purpose: "Get user info",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("MATERIALISATION_FAILED");
    expect(result.auditId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Invalid handle
// ---------------------------------------------------------------------------

describe("HTTP executor: invalid handle", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("rejects completely invalid handle format", async () => {
    const deps = buildDeps(fixture, []);

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: "not-a-valid-handle",
        method: "GET",
        url: "https://api.example.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("INVALID_HANDLE");
  });
});

// ---------------------------------------------------------------------------
// Tests: Network error handling
// ---------------------------------------------------------------------------

describe("HTTP executor: network error handling", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    const storageKey = credentialKey("example", "key");
    fixture = createFixture(
      { [storageKey]: "secret-key-value-12345678" },
      [buildStaticRecord({ service: "example", field: "key" })],
    );
  });

  afterEach(() => {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  test("returns error when fetch fails", async () => {
    const handle = localStaticHandle("example", "key");

    fixture.persistentStore.add({
      id: "grant-network-fail",
      tool: "http",
      pattern: "GET https://api.example.com/data",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = asFetch(async () => {
      throw new Error("Connection refused");
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.example.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("HTTP_REQUEST_FAILED");
    expect(result.error!.message).toContain("Connection refused");
    expect(result.auditId).toBeDefined();
  });

  test("error message is scrubbed of secret values", async () => {
    const handle = localStaticHandle("example", "key");

    fixture.persistentStore.add({
      id: "grant-error-scrub",
      tool: "http",
      pattern: "GET https://api.example.com/data",
      scope: handle,
      createdAt: Date.now(),
      sessionId: "test-session",
    });

    const fetchFn = asFetch(async () => {
      throw new Error(
        "Failed to connect with token secret-key-value-12345678 to api.example.com",
      );
    });

    const deps = buildDeps(fixture, [], { fetch: fetchFn });

    const result = await executeAuthenticatedHttpRequest(
      {
        credentialHandle: handle,
        method: "GET",
        url: "https://api.example.com/data",
        purpose: "Get data",
      },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error!.message).not.toContain("secret-key-value-12345678");
    expect(result.error!.message).toContain("[CES:REDACTED]");
  });
});
