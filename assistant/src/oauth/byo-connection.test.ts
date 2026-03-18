import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
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
  `vellum-byo-conn-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock OAuth2 token refresh
// ---------------------------------------------------------------------------

let mockRefreshOAuth2Token: ReturnType<
  typeof mock<
    () => Promise<{
      accessToken: string;
      expiresIn: number;
      refreshToken?: string;
    }>
  >
>;

mock.module("../security/oauth2.js", () => {
  mockRefreshOAuth2Token = mock(() =>
    Promise.resolve({
      accessToken: "refreshed-access-token",
      expiresIn: 3600,
    }),
  );
  return {
    refreshOAuth2Token: mockRefreshOAuth2Token,
  };
});

// ---------------------------------------------------------------------------
// Mock oauth-store — token-manager reads refresh config from SQLite
// ---------------------------------------------------------------------------

/** Mutable per-test map of provider connections for getConnectionByProvider */
const mockConnections = new Map<
  string,
  {
    id: string;
    providerKey: string;
    oauthAppId: string;
    expiresAt: number | null;
    grantedScopes?: string;
    accountInfo?: string | null;
  }
>();
const mockApps = new Map<
  string,
  {
    id: string;
    providerKey: string;
    clientId: string;
    clientSecretCredentialPath: string;
  }
>();
const mockProviders = new Map<
  string,
  {
    key: string;
    tokenUrl: string;
    tokenEndpointAuthMethod?: string;
    baseUrl?: string;
  }
>();

mock.module("./oauth-store.js", () => ({
  getConnectionByProvider: (service: string) => mockConnections.get(service),
  getConnection: (id: string) => {
    for (const conn of mockConnections.values()) {
      if (conn.id === id) return conn;
    }
    return undefined;
  },
  getApp: (id: string) => mockApps.get(id),
  getProvider: (key: string) => mockProviders.get(key),
  updateConnection: () => {},
  getMostRecentAppByProvider: () => undefined,
  listConnections: () => [],
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { setSecureKeyAsync } from "../security/secure-keys.js";
import {
  _resetInflightRefreshes,
  _resetRefreshBreakers,
} from "../security/token-manager.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import { resolveOAuthConnection } from "./connection-resolver.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock<any>>;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  _setStorePath(STORE_PATH);
  _setMetadataPath(join(TEST_DIR, "metadata.json"));
  _resetBackend();
  _resetRefreshBreakers();
  _resetInflightRefreshes();
  // Clear mock oauth-store maps
  mockConnections.clear();
  mockApps.clear();
  mockProviders.clear();

  // Default mock fetch returning 200 JSON
  mockFetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Clean up store for next test
  try {
    rmSync(STORE_PATH, { force: true });
    rmSync(join(TEST_DIR, "metadata.json"), { force: true });
  } catch {
    // ignore
  }
});

async function setupCredential(
  service: string,
  opts?: { expiresAt?: number; grantedScopes?: string[] },
) {
  // Seed mock oauth-store maps so token-manager can resolve refresh config
  const appId = `app-${service}`;
  const connId = `conn-${service}`;
  mockProviders.set(service, {
    key: service,
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Only well-known providers (gmail) have a baseUrl; custom services don't
    baseUrl:
      service === "integration:google"
        ? "https://gmail.googleapis.com/gmail/v1/users/me"
        : undefined,
  });
  mockApps.set(appId, {
    id: appId,
    providerKey: service,
    clientId: "test-client-id",
    clientSecretCredentialPath: `oauth_app/${appId}/client_secret`,
  });
  mockConnections.set(service, {
    id: connId,
    providerKey: service,
    oauthAppId: appId,
    expiresAt: opts?.expiresAt ?? Date.now() + 3600 * 1000,
    grantedScopes: JSON.stringify(opts?.grantedScopes ?? ["read", "write"]),
    accountInfo: null,
  });
  // Store access token in oauth-store key format
  await setSecureKeyAsync(
    `oauth_connection/${connId}/access_token`,
    "test-access-token",
  );
  // Store refresh token and client_secret in secure keys (token-manager reads them)
  await setSecureKeyAsync(
    `oauth_connection/${connId}/refresh_token`,
    "test-refresh-token",
  );
  await setSecureKeyAsync(
    `oauth_app/${appId}/client_secret`,
    "test-client-secret",
  );
  upsertCredentialMetadata(service, "access_token", {});
}

function createConnection(service = "integration:google"): BYOOAuthConnection {
  return new BYOOAuthConnection({
    id: `conn-${service}`,
    providerKey: service,
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    accountInfo: null,
    grantedScopes: ["read", "write"],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BYOOAuthConnection", () => {
  describe("request()", () => {
    test("makes authenticated request with Bearer token", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      const result = await conn.request({
        method: "GET",
        path: "/messages",
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      );
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer test-access-token");
      // GET requests have no body, so Content-Type should not be set
      expect(headers.has("Content-Type")).toBe(false);
      expect((init as RequestInit).method).toBe("GET");
    });

    test("appends query parameters", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      await conn.request({
        method: "GET",
        path: "/messages",
        query: { maxResults: "10", labelIds: "INBOX" },
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url as string);
      expect(parsed.searchParams.get("maxResults")).toBe("10");
      expect(parsed.searchParams.get("labelIds")).toBe("INBOX");
    });

    test("uses per-request baseUrl override", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      await conn.request({
        method: "GET",
        path: "/calendars",
        baseUrl: "https://www.googleapis.com/calendar/v3",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars");
    });

    test("sends JSON body for POST requests", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      await conn.request({
        method: "POST",
        path: "/messages/send",
        body: { raw: "base64-encoded-email" },
      });

      const [, init] = mockFetch.mock.calls[0];
      expect((init as RequestInit).body).toBe(
        JSON.stringify({ raw: "base64-encoded-email" }),
      );
      expect((init as RequestInit).method).toBe("POST");
      // POST requests with a body should include Content-Type
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    test("retries once on 401 response", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      // First call returns 401, second returns 200
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response("Unauthorized", { status: 401 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      }) as unknown as typeof fetch;

      const result = await conn.request({
        method: "GET",
        path: "/messages",
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(callCount).toBe(2);
      // Verify refresh was called
      expect(mockRefreshOAuth2Token).toHaveBeenCalled();
    });

    test("handles empty response body", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("", { status: 204 })),
      ) as unknown as typeof fetch;

      const result = await conn.request({
        method: "DELETE",
        path: "/messages/123",
      });

      expect(result.status).toBe(204);
      expect(result.body).toBeNull();
    });

    test("handles non-JSON response body", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("plain text response", { status: 200 })),
      ) as unknown as typeof fetch;

      const result = await conn.request({
        method: "GET",
        path: "/raw",
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe("plain text response");
    });

    test("returns response headers", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: {
              "x-ratelimit-remaining": "99",
              "content-type": "application/json",
            },
          }),
        ),
      ) as unknown as typeof fetch;

      const result = await conn.request({
        method: "GET",
        path: "/messages",
      });

      expect(result.headers["x-ratelimit-remaining"]).toBe("99");
    });

    test("includes custom request headers", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      await conn.request({
        method: "GET",
        path: "/messages",
        headers: { "X-Custom-Header": "custom-value" },
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.get("X-Custom-Header")).toBe("custom-value");
      expect(headers.get("Authorization")).toBe("Bearer test-access-token");
    });
  });

  describe("proactive token refresh", () => {
    test("refreshes token when near expiry (within 5-minute buffer)", async () => {
      // Set token to expire in 2 minutes (within 5-min buffer)
      await setupCredential("integration:google", {
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      const conn = createConnection();

      await conn.request({
        method: "GET",
        path: "/messages",
      });

      // Token should have been refreshed proactively
      expect(mockRefreshOAuth2Token).toHaveBeenCalled();

      // The request should use the refreshed token
      const [, init] = mockFetch.mock.calls[0];
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.get("Authorization")).toBe(
        "Bearer refreshed-access-token",
      );
    });
  });

  describe("withToken()", () => {
    test("provides valid token to callback", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      const result = await conn.withToken(async (token) => {
        return `got-${token}`;
      });

      expect(result).toBe("got-test-access-token");
    });

    test("retries callback on 401 error", async () => {
      await setupCredential("integration:google");
      const conn = createConnection();

      let callCount = 0;
      const result = await conn.withToken(async (token) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error("Unauthorized");
          (err as Error & { status: number }).status = 401;
          throw err;
        }
        return `got-${token}`;
      });

      expect(callCount).toBe(2);
      expect(result).toBe("got-refreshed-access-token");
      expect(mockRefreshOAuth2Token).toHaveBeenCalled();
    });
  });

  describe("missing credential", () => {
    test("throws when no access token exists", async () => {
      const conn = createConnection();

      await expect(
        conn.request({ method: "GET", path: "/messages" }),
      ).rejects.toThrow(/No access token found/);
    });
  });
});

describe("resolveOAuthConnection", () => {
  test("returns a BYOOAuthConnection for valid credential", async () => {
    await setupCredential("integration:google");
    const conn = await resolveOAuthConnection("integration:google");

    expect(conn).toBeInstanceOf(BYOOAuthConnection);
    expect(conn.providerKey).toBe("integration:google");
    expect(conn.grantedScopes).toEqual(["read", "write"]);
  });

  test("throws when no credential metadata exists", async () => {
    await expect(resolveOAuthConnection("integration:unknown")).rejects.toThrow(
      /No credential found for "integration:unknown"/,
    );
  });

  test("throws when no base URL configured", async () => {
    await setupCredential("integration:custom-service");
    await expect(
      resolveOAuthConnection("integration:custom-service"),
    ).rejects.toThrow(
      /No base URL configured for "integration:custom-service"/,
    );
  });
});
