import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "oauth-store-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => ":memory:",
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockDeleteSecureKeyAsync = mock(() =>
  Promise.resolve("deleted" as const),
);
const mockSetSecureKeyAsync = mock(() => Promise.resolve(true));
/** Simulated secure key store for getSecureKey lookups. */
const secureKeyValues = new Map<string, string>();
mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: mockDeleteSecureKeyAsync,
  setSecureKeyAsync: mockSetSecureKeyAsync,
  getSecureKey: (account: string) => secureKeyValues.get(account),
}));

import { initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import {
  createConnection,
  deleteApp,
  deleteConnection,
  disconnectOAuthProvider,
  getApp,
  getAppByProviderAndClientId,
  getConnection,
  getConnectionByProvider,
  getProvider,
  isProviderConnected,
  listConnections,
  registerProvider,
  seedProviders,
  updateConnection,
  upsertApp,
} from "../oauth/oauth-store.js";

initializeDb();

/** Seed a minimal provider row for FK satisfaction. */
function seedTestProvider(providerKey = "github"): void {
  seedProviders([
    {
      providerKey,
      authUrl: `https://${providerKey}.example.com/authorize`,
      tokenUrl: `https://${providerKey}.example.com/token`,
      defaultScopes: ["read"],
      scopePolicy: {},
    },
  ]);
}

/** Create an app linked to the given provider. Returns the app row. */
async function createTestApp(providerKey = "github", clientId = "client-1") {
  seedTestProvider(providerKey);
  return await upsertApp(providerKey, clientId);
}

beforeEach(() => {
  resetDb();
  initializeDb();
  // Explicitly clear all OAuth tables to prevent cross-test state pollution.
  // Delete in FK-dependency order: connections → apps → providers.
  resetTestTables("oauth_connections", "oauth_apps", "oauth_providers");
  mockDeleteSecureKeyAsync.mockClear();
  mockSetSecureKeyAsync.mockClear();
  secureKeyValues.clear();
});

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Provider operations
// ---------------------------------------------------------------------------

describe("provider operations", () => {
  describe("seedProviders", () => {
    test("creates rows for new providers", () => {
      seedProviders([
        {
          providerKey: "github",
          authUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          defaultScopes: ["repo", "user"],
          scopePolicy: { required: ["repo"] },
        },
        {
          providerKey: "google",
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          defaultScopes: ["openid", "email"],
          scopePolicy: {},
          extraParams: { access_type: "offline" },
        },
      ]);

      const gh = getProvider("github");
      expect(gh).toBeDefined();
      expect(gh!.providerKey).toBe("github");
      expect(gh!.authUrl).toBe("https://github.com/login/oauth/authorize");
      expect(gh!.tokenUrl).toBe("https://github.com/login/oauth/access_token");
      expect(JSON.parse(gh!.defaultScopes)).toEqual(["repo", "user"]);
      expect(JSON.parse(gh!.scopePolicy)).toEqual({ required: ["repo"] });

      const goog = getProvider("google");
      expect(goog).toBeDefined();
      expect(goog!.providerKey).toBe("google");
      expect(JSON.parse(goog!.extraParams!)).toEqual({
        access_type: "offline",
      });
    });

    test("updates existing provider rows with corrected seed data", () => {
      seedProviders([
        {
          providerKey: "github",
          authUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          defaultScopes: ["repo"],
          scopePolicy: {},
          baseUrl: "https://api.github.com",
        },
      ]);

      const original = getProvider("github");
      expect(original).toBeDefined();
      expect(original!.baseUrl).toBe("https://api.github.com");
      const originalCreatedAt = original!.createdAt;

      // Re-seed with corrected values (simulates a code fix deployed on upgrade)
      seedProviders([
        {
          providerKey: "github",
          authUrl: "https://github.com/login/oauth/authorize-v2",
          tokenUrl: "https://github.com/login/oauth/access_token-v2",
          defaultScopes: ["repo", "user"],
          scopePolicy: { required: ["repo"] },
          baseUrl: "https://api.github.com/v2",
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();
      // Seed data should overwrite the existing row
      expect(row!.authUrl).toBe("https://github.com/login/oauth/authorize-v2");
      expect(row!.tokenUrl).toBe(
        "https://github.com/login/oauth/access_token-v2",
      );
      expect(row!.baseUrl).toBe("https://api.github.com/v2");
      expect(JSON.parse(row!.defaultScopes)).toEqual(["repo", "user"]);
      expect(JSON.parse(row!.scopePolicy)).toEqual({ required: ["repo"] });
      // createdAt should be preserved from the original insert
      expect(row!.createdAt).toBe(originalCreatedAt);
    });
  });

  describe("getProvider", () => {
    test("returns the correct row", () => {
      seedProviders([
        {
          providerKey: "github",
          authUrl: "https://github.com/authorize",
          tokenUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
          callbackTransport: "loopback",
          loopbackPort: 8765,
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();
      expect(row!.providerKey).toBe("github");
      expect(row!.callbackTransport).toBe("loopback");
      expect(row!.loopbackPort).toBe(8765);
    });

    test("returns undefined for unknown keys", () => {
      expect(getProvider("nonexistent")).toBeUndefined();
    });
  });

  describe("registerProvider", () => {
    test("creates a new row", () => {
      const row = registerProvider({
        providerKey: "linear",
        authUrl: "https://linear.app/oauth/authorize",
        tokenUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      expect(row.providerKey).toBe("linear");
      expect(row.authUrl).toBe("https://linear.app/oauth/authorize");

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.providerKey).toBe("linear");
    });

    test("throws for duplicate provider_key", () => {
      registerProvider({
        providerKey: "linear",
        authUrl: "https://linear.app/oauth/authorize",
        tokenUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      expect(() =>
        registerProvider({
          providerKey: "linear",
          authUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        }),
      ).toThrow(/already exists.*linear/);
    });
  });
});

// ---------------------------------------------------------------------------
// App operations
// ---------------------------------------------------------------------------

describe("app operations", () => {
  describe("upsertApp", () => {
    test("creates a new app and returns it with a UUID", async () => {
      seedTestProvider("github");
      const app = await upsertApp("github", "client-abc");

      expect(app.id).toBeTruthy();
      // UUID v4 format check
      expect(app.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(app.providerKey).toBe("github");
      expect(app.clientId).toBe("client-abc");
      expect(app.createdAt).toBeGreaterThan(0);
      expect(app.updatedAt).toBeGreaterThan(0);
    });

    test("returns the existing app when called again with same (providerKey, clientId)", async () => {
      seedTestProvider("github");
      const first = await upsertApp("github", "client-abc");
      const second = await upsertApp("github", "client-abc");

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });

    test("stores clientSecret in secure storage on new app creation", async () => {
      seedTestProvider("github");
      const app = await upsertApp("github", "client-abc", "my-secret");

      expect(mockSetSecureKeyAsync).toHaveBeenCalledTimes(1);
      expect(mockSetSecureKeyAsync).toHaveBeenCalledWith(
        `oauth_app/${app.id}/client_secret`,
        "my-secret",
      );
    });

    test("stores clientSecret in secure storage when upserting an existing app", async () => {
      seedTestProvider("github");
      const first = await upsertApp("github", "client-abc");
      mockSetSecureKeyAsync.mockClear();

      await upsertApp("github", "client-abc", "updated-secret");

      expect(mockSetSecureKeyAsync).toHaveBeenCalledTimes(1);
      expect(mockSetSecureKeyAsync).toHaveBeenCalledWith(
        `oauth_app/${first.id}/client_secret`,
        "updated-secret",
      );
    });

    test("throws when setSecureKeyAsync returns false", async () => {
      seedTestProvider("github");
      mockSetSecureKeyAsync.mockResolvedValueOnce(false);

      await expect(
        upsertApp("github", "client-abc", "bad-secret"),
      ).rejects.toThrow("Failed to store client_secret in secure storage");
    });
  });

  describe("getApp", () => {
    test("returns the correct row by id", async () => {
      const app = await createTestApp("github", "client-1");
      const fetched = getApp(app.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(app.id);
      expect(fetched!.providerKey).toBe("github");
      expect(fetched!.clientId).toBe("client-1");
    });

    test("returns undefined for unknown id", () => {
      expect(getApp("nonexistent-id")).toBeUndefined();
    });
  });

  describe("getAppByProviderAndClientId", () => {
    test("returns the correct row", async () => {
      const app = await createTestApp("github", "client-1");
      const fetched = getAppByProviderAndClientId("github", "client-1");

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(app.id);
    });

    test("returns undefined for unknown combination", () => {
      expect(
        getAppByProviderAndClientId("github", "nonexistent"),
      ).toBeUndefined();
    });
  });

  describe("deleteApp", () => {
    test("removes the row and returns true", async () => {
      const app = await createTestApp("github", "client-1");
      const deleted = await deleteApp(app.id);

      expect(deleted).toBe(true);
      expect(getApp(app.id)).toBeUndefined();
    });

    test("returns false for nonexistent id", async () => {
      expect(await deleteApp("nonexistent-id")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Connection operations
// ---------------------------------------------------------------------------

describe("connection operations", () => {
  describe("createConnection", () => {
    test("creates a row with status='active'", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo", "user"],
        hasRefreshToken: true,
        accountInfo: "user@example.com",
        label: "Primary GitHub",
        metadata: { login: "octocat" },
      });

      expect(conn.id).toBeTruthy();
      expect(conn.oauthAppId).toBe(app.id);
      expect(conn.providerKey).toBe("github");
      expect(conn.status).toBe("active");
      expect(JSON.parse(conn.grantedScopes)).toEqual(["repo", "user"]);
      expect(conn.hasRefreshToken).toBe(1);
      expect(conn.accountInfo).toBe("user@example.com");
      expect(conn.label).toBe("Primary GitHub");
      expect(JSON.parse(conn.metadata!)).toEqual({ login: "octocat" });
      expect(conn.createdAt).toBeGreaterThan(0);
    });
  });

  describe("getConnection", () => {
    test("returns the correct row", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const fetched = getConnection(conn.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(conn.id);
      expect(fetched!.providerKey).toBe("github");
    });

    test("returns undefined for unknown id", () => {
      expect(getConnection("nonexistent-id")).toBeUndefined();
    });
  });

  describe("getConnectionByProvider", () => {
    test("returns the most recent active connection", async () => {
      const app = await createTestApp("github", "client-1");

      // Create two connections with explicit timestamps so ordering is deterministic
      createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo", "user"],
        hasRefreshToken: true,
        createdAt: 2000,
      });

      const result = getConnectionByProvider("github");
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn2.id);
    });

    test("skips connections with status='revoked'", async () => {
      const app = await createTestApp("github", "client-1");

      const conn1 = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo", "user"],
        hasRefreshToken: true,
      });

      // Revoke the most recent connection
      updateConnection(conn2.id, { status: "revoked" });

      const result = getConnectionByProvider("github");
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn1.id);
    });

    test("skips connections with status='expired'", async () => {
      const app = await createTestApp("github", "client-1");

      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      updateConnection(conn.id, { status: "expired" });

      const result = getConnectionByProvider("github");
      expect(result).toBeUndefined();
    });

    test("returns undefined when no active connections exist", () => {
      expect(getConnectionByProvider("github")).toBeUndefined();
    });
  });

  describe("isProviderConnected", () => {
    test("returns true when active connection has an access token in secure storage", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "tok");

      expect(isProviderConnected("github")).toBe(true);
    });

    test("returns false when active connection exists but access token is missing", async () => {
      const app = await createTestApp("github", "client-1");
      createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      // No secure key set — simulates failed token write
      expect(isProviderConnected("github")).toBe(false);
    });

    test("returns false when no connection exists", () => {
      expect(isProviderConnected("github")).toBe(false);
    });

    test("returns false when connection is revoked even with token in store", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      updateConnection(conn.id, { status: "revoked" });
      secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "tok");

      expect(isProviderConnected("github")).toBe(false);
    });
  });

  describe("updateConnection", () => {
    test("modifies specific fields", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const updated = updateConnection(conn.id, {
        status: "revoked",
        label: "Revoked account",
        grantedScopes: ["repo", "user", "gist"],
        hasRefreshToken: true,
        metadata: { reason: "user-requested" },
      });

      expect(updated).toBe(true);

      const fetched = getConnection(conn.id);
      expect(fetched).toBeDefined();
      expect(fetched!.status).toBe("revoked");
      expect(fetched!.label).toBe("Revoked account");
      expect(JSON.parse(fetched!.grantedScopes)).toEqual([
        "repo",
        "user",
        "gist",
      ]);
      expect(fetched!.hasRefreshToken).toBe(1);
      expect(JSON.parse(fetched!.metadata!)).toEqual({
        reason: "user-requested",
      });
      expect(fetched!.updatedAt).toBeGreaterThanOrEqual(conn.createdAt);
    });

    test("updates oauthAppId to a different app", async () => {
      const app1 = await createTestApp("github", "client-1");
      const app2 = await upsertApp("github", "client-2");

      const conn = createConnection({
        oauthAppId: app1.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      expect(getConnection(conn.id)!.oauthAppId).toBe(app1.id);

      const updated = updateConnection(conn.id, { oauthAppId: app2.id });
      expect(updated).toBe(true);

      const fetched = getConnection(conn.id);
      expect(fetched).toBeDefined();
      expect(fetched!.oauthAppId).toBe(app2.id);
    });

    test("returns false for nonexistent id", () => {
      expect(updateConnection("nonexistent-id", { status: "revoked" })).toBe(
        false,
      );
    });
  });

  describe("listConnections", () => {
    test("returns all connections when no filter is given", async () => {
      const ghApp = await createTestApp("github", "client-1");
      seedTestProvider("google");
      const googApp = await upsertApp("google", "client-2");

      createConnection({
        oauthAppId: ghApp.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      createConnection({
        oauthAppId: googApp.id,
        providerKey: "google",
        grantedScopes: ["email"],
        hasRefreshToken: true,
      });

      const all = listConnections();
      expect(all).toHaveLength(2);
    });

    test("filters by provider key", async () => {
      const ghApp = await createTestApp("github", "client-1");
      seedTestProvider("google");
      const googApp = await upsertApp("google", "client-2");

      createConnection({
        oauthAppId: ghApp.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      createConnection({
        oauthAppId: googApp.id,
        providerKey: "google",
        grantedScopes: ["email"],
        hasRefreshToken: true,
      });

      const ghConns = listConnections("github");
      expect(ghConns).toHaveLength(1);
      expect(ghConns[0].providerKey).toBe("github");

      const googConns = listConnections("google");
      expect(googConns).toHaveLength(1);
      expect(googConns[0].providerKey).toBe("google");
    });

    test("returns empty array when no connections exist", () => {
      expect(listConnections()).toEqual([]);
    });
  });

  describe("deleteConnection", () => {
    test("removes the row and returns true", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const deleted = deleteConnection(conn.id);
      expect(deleted).toBe(true);
      expect(getConnection(conn.id)).toBeUndefined();
    });

    test("returns false for nonexistent id", () => {
      expect(deleteConnection("nonexistent-id")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// disconnectOAuthProvider
// ---------------------------------------------------------------------------

describe("disconnectOAuthProvider", () => {
  test("returns false when no connection exists for the provider", async () => {
    const result = await disconnectOAuthProvider("github");
    expect(result).toBe(false);
    expect(mockDeleteSecureKeyAsync).not.toHaveBeenCalled();
  });

  test("returns true and deletes connection row and secure keys when connection exists", async () => {
    const app = await createTestApp("github", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      providerKey: "github",
      grantedScopes: ["repo"],
      hasRefreshToken: true,
    });

    const result = await disconnectOAuthProvider("github");
    expect(result).toBe(true);

    // Verify secure keys were deleted
    expect(mockDeleteSecureKeyAsync).toHaveBeenCalledTimes(2);
    expect(mockDeleteSecureKeyAsync).toHaveBeenCalledWith(
      `oauth_connection/${conn.id}/access_token`,
    );
    expect(mockDeleteSecureKeyAsync).toHaveBeenCalledWith(
      `oauth_connection/${conn.id}/refresh_token`,
    );

    // Verify connection row was deleted
    expect(getConnection(conn.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FK constraint enforcement
// ---------------------------------------------------------------------------

describe("FK constraints", () => {
  test("creating an app with a nonexistent provider_key fails", async () => {
    await expect(
      upsertApp("nonexistent-provider", "client-1"),
    ).rejects.toThrow();
  });

  test("creating a connection with a nonexistent oauth_app_id fails", () => {
    seedTestProvider("github");
    expect(() =>
      createConnection({
        oauthAppId: "nonexistent-app-id",
        providerKey: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      }),
    ).toThrow();
  });
});
