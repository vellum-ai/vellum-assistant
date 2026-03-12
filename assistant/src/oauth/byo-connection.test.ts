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
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetMigrationFlag,
  credentialKey,
} from "../security/credential-key.js";
import { setSecureKey } from "../security/secure-keys.js";
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
  _resetMigrationFlag();

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

function setupCredential(
  service: string,
  opts?: { expiresAt?: number; grantedScopes?: string[] },
) {
  setSecureKey(credentialKey(service, "access_token"), "test-access-token");
  setSecureKey(credentialKey(service, "refresh_token"), "test-refresh-token");
  setSecureKey(credentialKey(service, "client_secret"), "test-client-secret");
  upsertCredentialMetadata(service, "access_token", {
    expiresAt: opts?.expiresAt ?? Date.now() + 3600 * 1000,
    grantedScopes: opts?.grantedScopes ?? ["read", "write"],
    oauth2TokenUrl: "https://oauth2.googleapis.com/token",
    oauth2ClientId: "test-client-id",
    hasRefreshToken: true,
  });
}

function createConnection(service = "integration:gmail"): BYOOAuthConnection {
  return new BYOOAuthConnection({
    id: "test-cred-id",
    providerKey: service,
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    accountInfo: null,
    grantedScopes: ["read", "write"],
    credentialService: service,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BYOOAuthConnection", () => {
  describe("request()", () => {
    test("makes authenticated request with Bearer token", async () => {
      setupCredential("integration:gmail");
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
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer test-access-token",
        "Content-Type": "application/json",
      });
      expect((init as RequestInit).method).toBe("GET");
    });

    test("appends query parameters", async () => {
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
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
    });

    test("retries once on 401 response", async () => {
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
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
      setupCredential("integration:gmail");
      const conn = createConnection();

      await conn.request({
        method: "GET",
        path: "/messages",
        headers: { "X-Custom-Header": "custom-value" },
      });

      const [, init] = mockFetch.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer test-access-token",
      });
    });
  });

  describe("proactive token refresh", () => {
    test("refreshes token when near expiry (within 5-minute buffer)", async () => {
      // Set token to expire in 2 minutes (within 5-min buffer)
      setupCredential("integration:gmail", {
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
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer refreshed-access-token",
      });
    });
  });

  describe("withToken()", () => {
    test("provides valid token to callback", async () => {
      setupCredential("integration:gmail");
      const conn = createConnection();

      const result = await conn.withToken(async (token) => {
        return `got-${token}`;
      });

      expect(result).toBe("got-test-access-token");
    });

    test("retries callback on 401 error", async () => {
      setupCredential("integration:gmail");
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
  test("returns a BYOOAuthConnection for valid credential", () => {
    setupCredential("integration:gmail");
    const conn = resolveOAuthConnection("integration:gmail");

    expect(conn).toBeInstanceOf(BYOOAuthConnection);
    expect(conn.providerKey).toBe("integration:gmail");
    expect(conn.grantedScopes).toEqual(["read", "write"]);
  });

  test("throws when no credential metadata exists", () => {
    expect(() => resolveOAuthConnection("integration:unknown")).toThrow(
      /No credential found for "integration:unknown"/,
    );
  });

  test("throws when no base URL configured", () => {
    setupCredential("integration:custom-service");
    expect(() => resolveOAuthConnection("integration:custom-service")).toThrow(
      /No base URL configured for "integration:custom-service"/,
    );
  });
});
