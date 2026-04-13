/**
 * Tests for CES local-token-refresh `refresh_url` support.
 *
 * Verifies that `createLocalTokenRefreshFn`:
 * 1. Uses `refresh_url` when it is set on the provider.
 * 2. Falls back to `token_url` when `refresh_url` is null or empty.
 * 3. Preserves existing `token_exchange_body_format` and `token_endpoint_auth_method` behaviour.
 */

import Database from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

import { createLocalTokenRefreshFn } from "../materializers/local-token-refresh.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/** Unique temp root for each test run. */
let tmpRoot: string;

function setupTestDb(opts: {
  providerKey?: string;
  tokenUrl?: string;
  refreshUrl?: string | null;
  tokenEndpointAuthMethod?: string | null;
  tokenExchangeBodyFormat?: string | null;
}): string {
  const providerKey = opts.providerKey ?? "test-provider";
  const tokenUrl = opts.tokenUrl ?? "https://provider.example.com/token";
  const refreshUrl = opts.refreshUrl ?? null;
  const authMethod = opts.tokenEndpointAuthMethod ?? "client_secret_post";
  const bodyFormat = opts.tokenExchangeBodyFormat ?? "form";

  tmpRoot = join(
    "/tmp",
    `ces-token-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbDir = join(tmpRoot, "workspace", "data", "db");
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, "assistant.db");
  const db = new Database(dbPath);

  // Create minimal schema matching the assistant's tables
  db.exec(/*sql*/ `
    CREATE TABLE oauth_providers (
      provider_key TEXT PRIMARY KEY,
      auth_url TEXT NOT NULL,
      token_url TEXT NOT NULL,
      refresh_url TEXT,
      token_endpoint_auth_method TEXT,
      token_exchange_body_format TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(/*sql*/ `
    CREATE TABLE oauth_apps (
      id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL REFERENCES oauth_providers(provider_key),
      client_id TEXT NOT NULL,
      client_secret_credential_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(/*sql*/ `
    CREATE TABLE oauth_connections (
      id TEXT PRIMARY KEY,
      oauth_app_id TEXT NOT NULL REFERENCES oauth_apps(id),
      provider_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const now = Date.now();

  db.exec(/*sql*/ `
    INSERT INTO oauth_providers (provider_key, auth_url, token_url, refresh_url, token_endpoint_auth_method, token_exchange_body_format, created_at, updated_at)
    VALUES ('${providerKey}', 'https://provider.example.com/authorize', '${tokenUrl}', ${refreshUrl === null ? "NULL" : `'${refreshUrl}'`}, ${authMethod === null ? "NULL" : `'${authMethod}'`}, ${bodyFormat === null ? "NULL" : `'${bodyFormat}'`}, ${now}, ${now})
  `);

  db.exec(/*sql*/ `
    INSERT INTO oauth_apps (id, provider_key, client_id, client_secret_credential_path, created_at, updated_at)
    VALUES ('app-1', '${providerKey}', 'test-client-id', 'oauth_app/app-1/client_secret', ${now}, ${now})
  `);

  db.exec(/*sql*/ `
    INSERT INTO oauth_connections (id, oauth_app_id, provider_key, status, created_at, updated_at)
    VALUES ('conn-1', 'app-1', '${providerKey}', 'active', ${now}, ${now})
  `);

  db.close();
  return tmpRoot;
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(capturedUrls: string[]): void {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    capturedUrls.push(url);
    return new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLocalTokenRefreshFn – refresh_url support", () => {
  const capturedUrls: string[] = [];

  beforeEach(() => {
    capturedUrls.length = 0;
    mockFetch(capturedUrls);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("uses refresh_url when set on the provider", async () => {
    const root = setupTestDb({
      tokenUrl: "https://provider.example.com/token",
      refreshUrl: "https://provider.example.com/refresh",
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe("https://provider.example.com/refresh");
  });

  test("falls back to token_url when refresh_url is null", async () => {
    const root = setupTestDb({
      tokenUrl: "https://provider.example.com/token",
      refreshUrl: null,
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe("https://provider.example.com/token");
  });

  test("falls back to token_url when refresh_url is an empty string", async () => {
    const root = setupTestDb({
      tokenUrl: "https://provider.example.com/token",
      refreshUrl: "",
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe("https://provider.example.com/token");
  });

  test("preserves token_endpoint_auth_method=client_secret_basic behaviour", async () => {
    const root = setupTestDb({
      refreshUrl: "https://provider.example.com/refresh",
      tokenEndpointAuthMethod: "client_secret_basic",
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    // Capture the fetch call to verify Authorization header
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrls.push(url);
      if (init?.headers) {
        capturedHeaders.push(init.headers as Record<string, string>);
      }
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe("https://provider.example.com/refresh");

    // Verify Basic auth header was sent
    expect(capturedHeaders).toHaveLength(1);
    const expectedCredentials = Buffer.from("test-client-id:test-secret").toString("base64");
    expect(capturedHeaders[0]["Authorization"]).toBe(`Basic ${expectedCredentials}`);
  });

  test("preserves token_exchange_body_format=json behaviour", async () => {
    const root = setupTestDb({
      refreshUrl: "https://provider.example.com/refresh",
      tokenExchangeBodyFormat: "json",
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    const capturedContentTypes: string[] = [];
    const capturedBodies: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrls.push(url);
      if (init?.headers) {
        const headers = init.headers as Record<string, string>;
        capturedContentTypes.push(headers["Content-Type"] ?? "");
      }
      if (init?.body) {
        capturedBodies.push(typeof init.body === "string" ? init.body : String(init.body));
      }
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    expect(capturedContentTypes).toHaveLength(1);
    expect(capturedContentTypes[0]).toBe("application/json");

    // Verify the body was sent as JSON
    expect(capturedBodies).toHaveLength(1);
    const parsed = JSON.parse(capturedBodies[0]);
    expect(parsed.grant_type).toBe("refresh_token");
    expect(parsed.refresh_token).toBe("old-refresh-token");
  });

  test("returns successful token refresh result", async () => {
    const root = setupTestDb({
      refreshUrl: "https://provider.example.com/refresh",
    });

    const backend = createMemoryBackend({
      "oauth_app/app-1/client_secret": "test-secret",
    });

    const refreshFn = createLocalTokenRefreshFn(root, backend);
    const result = await refreshFn("conn-1", "old-refresh-token");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accessToken).toBe("new-access-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresAt).toBeTypeOf("number");
    }
  });
});
