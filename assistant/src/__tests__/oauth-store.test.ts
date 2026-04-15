import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockDeleteSecureKeyAsync = mock(
  (): Promise<"deleted" | "not-found" | "error"> =>
    Promise.resolve("deleted" as const),
);
const mockSetSecureKeyAsync = mock(() => Promise.resolve(true));
/** Simulated secure key store for getSecureKeyAsync lookups. */
const secureKeyValues = new Map<string, string>();
mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: mockDeleteSecureKeyAsync,
  setSecureKeyAsync: mockSetSecureKeyAsync,
  getSecureKeyAsync: (account: string) =>
    Promise.resolve(secureKeyValues.get(account)),
}));

import { eq } from "drizzle-orm";

import { getDb, initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateOAuthProvidersTokenAuthMethodDefault } from "../memory/migrations/216-oauth-providers-token-auth-method.js";
import { oauthProviders } from "../memory/schema/oauth.js";
import {
  createConnection,
  deleteApp,
  deleteConnection,
  disconnectOAuthProvider,
  getActiveConnection,
  getApp,
  getAppByProviderAndClientId,
  getConnection,
  getConnectionByProvider,
  getConnectionByProviderAndAccount,
  getProvider,
  isProviderConnected,
  listActiveConnectionsByProvider,
  listConnections,
  registerProvider,
  seedProviders,
  updateConnection,
  updateProvider,
  upsertApp,
} from "../oauth/oauth-store.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { getMockFetchCalls, mockFetch, resetMockFetch } from "./mock-fetch.js";

initializeDb();

/** Seed a minimal provider row for FK satisfaction. */
function seedTestProvider(provider = "github"): void {
  seedProviders([
    {
      provider,
      authorizeUrl: `https://${provider}.example.com/authorize`,
      tokenExchangeUrl: `https://${provider}.example.com/token`,
      defaultScopes: ["read"],
      scopePolicy: {},
    },
  ]);
}

/** Create an app linked to the given provider. Returns the app row. */
async function createTestApp(provider = "github", clientId = "client-1") {
  seedTestProvider(provider);
  return await upsertApp(provider, clientId);
}

beforeEach(() => {
  // Clear OAuth tables between tests instead of full DB reset + migration.
  // Delete in FK-dependency order: connections → apps → providers.
  resetTestTables("oauth_connections", "oauth_apps", "oauth_providers");
  mockDeleteSecureKeyAsync.mockClear();
  mockSetSecureKeyAsync.mockClear();
  secureKeyValues.clear();
  resetMockFetch();
});

afterAll(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// Provider operations
// ---------------------------------------------------------------------------

describe("provider operations", () => {
  describe("seedProviders", () => {
    test("creates rows for new providers", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          tokenExchangeUrl: "https://github.com/login/oauth/access_token",
          defaultScopes: ["repo", "user"],
          scopePolicy: { required: ["repo"] },
        },
        {
          provider: "google",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenExchangeUrl: "https://oauth2.googleapis.com/token",
          defaultScopes: ["openid", "email"],
          scopePolicy: {},
          authorizeParams: { access_type: "offline" },
        },
      ]);

      const gh = getProvider("github");
      expect(gh).toBeDefined();
      expect(gh!.provider).toBe("github");
      expect(gh!.authorizeUrl).toBe("https://github.com/login/oauth/authorize");
      expect(gh!.tokenExchangeUrl).toBe(
        "https://github.com/login/oauth/access_token",
      );
      expect(JSON.parse(gh!.defaultScopes)).toEqual(["repo", "user"]);
      expect(JSON.parse(gh!.scopePolicy)).toEqual({ required: ["repo"] });

      const goog = getProvider("google");
      expect(goog).toBeDefined();
      expect(goog!.provider).toBe("google");
      expect(JSON.parse(goog!.authorizeParams!)).toEqual({
        access_type: "offline",
      });
    });

    test("updates implementation fields while preserving user-customizable fields on re-seed", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          tokenExchangeUrl: "https://github.com/login/oauth/access_token",
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
          provider: "github",
          authorizeUrl: "https://github.com/login/oauth/authorize-v2",
          tokenExchangeUrl: "https://github.com/login/oauth/access_token-v2",
          defaultScopes: ["repo", "user"],
          scopePolicy: { required: ["repo"] },
          baseUrl: "https://api.github.com/v2",
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();
      // Implementation fields should be overwritten by the re-seed
      expect(row!.authorizeUrl).toBe(
        "https://github.com/login/oauth/authorize-v2",
      );
      expect(row!.tokenExchangeUrl).toBe(
        "https://github.com/login/oauth/access_token-v2",
      );
      // User-customizable fields (baseUrl, defaultScopes, scopePolicy) are
      // preserved from the original insert — not overwritten on re-seed.
      expect(row!.baseUrl).toBe("https://api.github.com");
      expect(JSON.parse(row!.defaultScopes)).toEqual(["repo"]);
      expect(JSON.parse(row!.scopePolicy)).toEqual({});
      // createdAt should be preserved from the original insert
      expect(row!.createdAt).toBe(originalCreatedAt);
    });

    test("persists pingUrl when provided", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
          pingUrl: "https://api.github.com/user",
        },
      ]);
      const row = getProvider("github");
      expect(row!.pingUrl).toBe("https://api.github.com/user");
    });

    test("pingUrl defaults to null when omitted", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);
      const row = getProvider("github");
      expect(row!.pingUrl).toBeNull();
    });

    test("preserves user-customizable fields while overwriting implementation fields on re-seed", () => {
      // Initial seed with all fields
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          tokenEndpointAuthMethod: "client_secret_post",
          defaultScopes: ["repo"],
          scopePolicy: { required: ["repo"] },
          userinfoUrl: "https://api.github.com/user",
          baseUrl: "https://api.github.com",
          authorizeParams: { prompt: "consent" },

          pingUrl: "https://api.github.com/user",
        },
      ]);

      // Manually update user-customizable fields to simulate user edits
      const db = getDb();
      db.update(oauthProviders)
        .set({
          defaultScopes: JSON.stringify(["repo", "user", "gist"]),
          scopePolicy: JSON.stringify({
            required: ["repo"],
            allowAdditionalScopes: true,
          }),
          baseUrl: "https://custom.github.com/api",
        })
        .where(eq(oauthProviders.provider, "github"))
        .run();

      // Verify the manual updates took effect
      const beforeReseed = getProvider("github");
      expect(JSON.parse(beforeReseed!.defaultScopes)).toEqual([
        "repo",
        "user",
        "gist",
      ]);
      expect(beforeReseed!.baseUrl).toBe("https://custom.github.com/api");

      // Re-seed with updated implementation fields
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize-v2",
          tokenExchangeUrl: "https://github.com/token-v2",
          tokenEndpointAuthMethod: "client_secret_basic",
          defaultScopes: ["repo-only"],
          scopePolicy: {},
          userinfoUrl: "https://api.github.com/user-v2",
          baseUrl: "https://api.github.com/v2",
          authorizeParams: { prompt: "login" },

          pingUrl: "https://api.github.com/user-v2",
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();

      // User-customizable fields should retain their manual values
      expect(JSON.parse(row!.defaultScopes)).toEqual(["repo", "user", "gist"]);
      expect(JSON.parse(row!.scopePolicy)).toEqual({
        required: ["repo"],
        allowAdditionalScopes: true,
      });
      expect(row!.baseUrl).toBe("https://custom.github.com/api");

      // Implementation fields should be overwritten from the seed data
      expect(row!.authorizeUrl).toBe("https://github.com/authorize-v2");
      expect(row!.tokenExchangeUrl).toBe("https://github.com/token-v2");
      expect(row!.tokenEndpointAuthMethod).toBe("client_secret_basic");
      expect(row!.userinfoUrl).toBe("https://api.github.com/user-v2");
      expect(JSON.parse(row!.authorizeParams!)).toEqual({ prompt: "login" });
      expect(row!.pingUrl).toBe("https://api.github.com/user-v2");
    });

    test("persists custom scopeSeparator when provided", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: ["read", "write"],
          scopePolicy: {},
          scopeSeparator: ",",
        },
      ]);

      const row = getProvider("test-provider");
      expect(row).toBeDefined();
      expect(row!.scopeSeparator).toBe(",");
    });

    test("scopeSeparator defaults to ' ' when omitted", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();
      expect(row!.scopeSeparator).toBe(" ");
    });

    test("re-seeding with a changed scopeSeparator overwrites the stored value", () => {
      seedProviders([
        {
          provider: "linear",
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenExchangeUrl: "https://api.linear.app/oauth/token",
          defaultScopes: ["read"],
          scopePolicy: {},
          scopeSeparator: " ",
        },
      ]);

      const first = getProvider("linear");
      expect(first!.scopeSeparator).toBe(" ");

      // Re-seed with a different separator — it should be overwritten,
      // proving scopeSeparator is in the onConflictDoUpdate set clause.
      seedProviders([
        {
          provider: "linear",
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenExchangeUrl: "https://api.linear.app/oauth/token",
          defaultScopes: ["read"],
          scopePolicy: {},
          scopeSeparator: ",",
        },
      ]);

      const row = getProvider("linear");
      expect(row!.scopeSeparator).toBe(",");
    });

    test("persists refreshUrl when provided", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          refreshUrl: "https://refresh.example.com/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row).toBeDefined();
      expect(row!.refreshUrl).toBe("https://refresh.example.com/token");
    });

    test("refreshUrl defaults to null when omitted", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row).toBeDefined();
      expect(row!.refreshUrl).toBeNull();
    });

    test("re-seeding with a changed refreshUrl overwrites the stored value", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          refreshUrl: "https://refresh.example.com/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const first = getProvider("test-provider");
      expect(first!.refreshUrl).toBe("https://refresh.example.com/token");

      // Re-seed with a different refreshUrl — it should be overwritten,
      // proving refreshUrl is in the onConflictDoUpdate set clause (not
      // preserved like defaultScopes).
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          refreshUrl: "https://refresh-v2.example.com/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row!.refreshUrl).toBe("https://refresh-v2.example.com/token");
    });

    test("persists revokeUrl and revokeBodyTemplate when provided", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          revokeUrl: "https://revoke.example.com",
          revokeBodyTemplate: { token: "{access_token}" },
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row).toBeDefined();
      expect(row!.revokeUrl).toBe("https://revoke.example.com");
      expect(JSON.parse(row!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });
    });

    test("revokeUrl and revokeBodyTemplate default to null when omitted", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row).toBeDefined();
      expect(row!.revokeUrl).toBeNull();
      expect(row!.revokeBodyTemplate).toBeNull();
    });

    test("writes logoUrl on insert", () => {
      seedProviders([
        {
          provider: "google",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenExchangeUrl: "https://oauth2.googleapis.com/token",
          defaultScopes: ["openid"],
          scopePolicy: {},
          logoUrl: "https://cdn.simpleicons.org/google",
        },
      ]);

      const row = getProvider("google");
      expect(row).toBeDefined();
      expect(row!.logoUrl).toBe("https://cdn.simpleicons.org/google");
    });

    test("overwrites logoUrl on conflict", () => {
      seedProviders([
        {
          provider: "google",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenExchangeUrl: "https://oauth2.googleapis.com/token",
          defaultScopes: ["openid"],
          scopePolicy: {},
          logoUrl: "https://cdn.simpleicons.org/google",
        },
      ]);

      expect(getProvider("google")!.logoUrl).toBe(
        "https://cdn.simpleicons.org/google",
      );

      // Re-seed with a different logoUrl — it should be overwritten,
      // proving logoUrl is in the onConflictDoUpdate set clause alongside
      // the other display-metadata fields.
      seedProviders([
        {
          provider: "google",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenExchangeUrl: "https://oauth2.googleapis.com/token",
          defaultScopes: ["openid"],
          scopePolicy: {},
          logoUrl: "https://cdn.simpleicons.org/google-v2",
        },
      ]);

      const row = getProvider("google");
      expect(row!.logoUrl).toBe("https://cdn.simpleicons.org/google-v2");
    });

    test("re-seeding with a changed revokeUrl overwrites the stored value", () => {
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          revokeUrl: "https://revoke.example.com",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const first = getProvider("test-provider");
      expect(first!.revokeUrl).toBe("https://revoke.example.com");

      // Re-seed with a different revokeUrl — it should be overwritten,
      // proving revokeUrl is in the onConflictDoUpdate set clause (not
      // preserved like defaultScopes).
      seedProviders([
        {
          provider: "test-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          revokeUrl: "https://revoke-v2.example.com",
          defaultScopes: ["read"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("test-provider");
      expect(row!.revokeUrl).toBe("https://revoke-v2.example.com");
    });

    test("seedOAuthProviders seeds Google, Twitter, and Linear with revoke config and leaves other providers null", () => {
      seedOAuthProviders();

      const google = getProvider("google");
      expect(google).toBeDefined();
      expect(google!.revokeUrl).toBe("https://oauth2.googleapis.com/revoke");
      expect(JSON.parse(google!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });

      const twitter = getProvider("twitter");
      expect(twitter).toBeDefined();
      expect(twitter!.revokeUrl).toBe("https://api.x.com/2/oauth2/revoke");
      expect(JSON.parse(twitter!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
        token_type_hint: "access_token",
        client_id: "{client_id}",
      });

      const linear = getProvider("linear");
      expect(linear).toBeDefined();
      expect(linear!.revokeUrl).toBe("https://api.linear.app/oauth/revoke");
      expect(JSON.parse(linear!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });

      const slack = getProvider("slack");
      expect(slack).toBeDefined();
      expect(slack!.revokeUrl).toBeNull();
      expect(slack!.revokeBodyTemplate).toBeNull();

      const github = getProvider("github");
      expect(github).toBeDefined();
      expect(github!.revokeUrl).toBeNull();

      const outlook = getProvider("outlook");
      expect(outlook).toBeDefined();
      expect(outlook!.revokeUrl).toBeNull();
    });

    test("applies client_secret_post default when tokenEndpointAuthMethod is omitted from seed", () => {
      seedProviders([
        {
          provider: "no-auth-method-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: [],
          scopePolicy: {},
          // Note: tokenEndpointAuthMethod intentionally omitted
        },
      ]);
      const row = getProvider("no-auth-method-provider");
      expect(row).toBeDefined();
      expect(row!.tokenEndpointAuthMethod).toBe("client_secret_post");
    });

    test("defaults tokenExchangeBodyFormat to 'form' when omitted from seed", () => {
      seedProviders([
        {
          provider: "no-body-format-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: [],
          scopePolicy: {},
          // Note: tokenExchangeBodyFormat intentionally omitted
        },
      ]);
      const row = getProvider("no-body-format-provider");
      expect(row).toBeDefined();
      expect(row!.tokenExchangeBodyFormat).toBe("form");
    });

    test("persists explicit tokenExchangeBodyFormat value on seed", () => {
      seedProviders([
        {
          provider: "json-body-format-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          defaultScopes: [],
          scopePolicy: {},
          tokenExchangeBodyFormat: "json",
        },
      ]);
      const row = getProvider("json-body-format-provider");
      expect(row).toBeDefined();
      expect(row!.tokenExchangeBodyFormat).toBe("json");
    });

    test("migration 216 backfills NULL token_endpoint_auth_method to client_secret_post", () => {
      // Use raw SQLite to bypass Drizzle's NOT NULL enforcement and insert
      // a legacy-shaped row with NULL token_endpoint_auth_method.
      const db = getDb();
      const raw = getSqliteFrom(db);
      raw.exec(`
        INSERT INTO oauth_providers (
          provider_key, auth_url, token_url, token_endpoint_auth_method,
          default_scopes, scope_policy, scope_separator, requires_client_secret,
          created_at, updated_at
        ) VALUES (
          'legacy-null-provider',
          'https://example.com/authorize',
          'https://example.com/token',
          NULL,
          '[]',
          '{}',
          ' ',
          1,
          ${Date.now()},
          ${Date.now()}
        )
      `);

      // Run the migration directly
      migrateOAuthProvidersTokenAuthMethodDefault(db);

      // Verify the row was backfilled
      const row = raw
        .prepare(
          `SELECT token_endpoint_auth_method FROM oauth_providers WHERE provider_key = 'legacy-null-provider'`,
        )
        .get() as { token_endpoint_auth_method: string };
      expect(row.token_endpoint_auth_method).toBe("client_secret_post");
    });

    test("migration 216 is idempotent — running twice on backfilled rows is a no-op", () => {
      seedProviders([
        {
          provider: "already-set-provider",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          tokenEndpointAuthMethod: "client_secret_basic",
          defaultScopes: [],
          scopePolicy: {},
        },
      ]);

      const db = getDb();
      migrateOAuthProvidersTokenAuthMethodDefault(db);
      migrateOAuthProvidersTokenAuthMethodDefault(db);

      const row = getProvider("already-set-provider");
      expect(row!.tokenEndpointAuthMethod).toBe("client_secret_basic");
    });
  });

  describe("getProvider", () => {
    test("returns the correct row", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const row = getProvider("github");
      expect(row).toBeDefined();
      expect(row!.provider).toBe("github");
    });

    test("returns undefined for unknown keys", () => {
      expect(getProvider("nonexistent")).toBeUndefined();
    });
  });

  describe("registerProvider", () => {
    test("creates a new row", () => {
      const row = registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      expect(row.provider).toBe("linear");
      expect(row.authorizeUrl).toBe("https://linear.app/oauth/authorize");

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.provider).toBe("linear");
    });

    test("throws for duplicate provider_key", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      expect(() =>
        registerProvider({
          provider: "linear",
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenExchangeUrl: "https://api.linear.app/oauth/token",
          defaultScopes: ["read"],
          scopePolicy: {},
        }),
      ).toThrow(/already exists.*linear/);
    });

    test("persists scopeSeparator and round-trips via getProvider", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        scopeSeparator: ";",
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.scopeSeparator).toBe(";");
    });

    test("scopeSeparator defaults to ' ' when omitted", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.scopeSeparator).toBe(" ");
    });

    test("persists refreshUrl and round-trips via getProvider", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        refreshUrl: "https://api.linear.app/oauth/refresh",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.refreshUrl).toBe("https://api.linear.app/oauth/refresh");
    });

    test("refreshUrl defaults to null when omitted", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.refreshUrl).toBeNull();
    });

    test("persists revokeUrl and revokeBodyTemplate and round-trips via getProvider", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        revokeUrl: "https://api.linear.app/oauth/revoke",
        revokeBodyTemplate: { token: "{access_token}" },
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.revokeUrl).toBe("https://api.linear.app/oauth/revoke");
      expect(JSON.parse(fetched!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });
    });

    test("applies client_secret_post default when tokenEndpointAuthMethod is omitted", () => {
      const row = registerProvider({
        provider: "custom-default-test",
        authorizeUrl: "https://example.com/authorize",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: [],
        scopePolicy: {},
        // Note: tokenEndpointAuthMethod intentionally omitted
      });
      expect(row.tokenEndpointAuthMethod).toBe("client_secret_post");

      const fetched = getProvider("custom-default-test");
      expect(fetched!.tokenEndpointAuthMethod).toBe("client_secret_post");
    });

    test("preserves explicit client_secret_basic when registering a provider", () => {
      const row = registerProvider({
        provider: "custom-basic-test",
        authorizeUrl: "https://example.com/authorize",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: [],
        scopePolicy: {},
        tokenEndpointAuthMethod: "client_secret_basic",
      });
      expect(row.tokenEndpointAuthMethod).toBe("client_secret_basic");
    });

    test("defaults tokenExchangeBodyFormat to 'form' when omitted", () => {
      const row = registerProvider({
        provider: "no-body-format-test",
        authorizeUrl: "https://example.com/authorize",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: [],
        scopePolicy: {},
        // Note: tokenExchangeBodyFormat intentionally omitted
      });
      expect(row.tokenExchangeBodyFormat).toBe("form");

      const fetched = getProvider("no-body-format-test");
      expect(fetched!.tokenExchangeBodyFormat).toBe("form");
    });

    test("persists explicit tokenExchangeBodyFormat 'json' when registering a provider", () => {
      const row = registerProvider({
        provider: "json-body-format-test",
        authorizeUrl: "https://example.com/authorize",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: [],
        scopePolicy: {},
        tokenExchangeBodyFormat: "json",
      });
      expect(row.tokenExchangeBodyFormat).toBe("json");
    });

    test("stores logoUrl when provided", () => {
      registerProvider({
        provider: "notion",
        authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        logoUrl: "https://cdn.simpleicons.org/notion",
      });

      const fetched = getProvider("notion");
      expect(fetched).toBeDefined();
      expect(fetched!.logoUrl).toBe("https://cdn.simpleicons.org/notion");
    });

    test("defaults logoUrl to null when omitted", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      const fetched = getProvider("linear");
      expect(fetched).toBeDefined();
      expect(fetched!.logoUrl).toBeNull();
    });
  });

  describe("updateProvider", () => {
    test("updates scopeSeparator on an existing row", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const before = getProvider("github");
      expect(before!.scopeSeparator).toBe(" ");

      const updated = updateProvider("github", { scopeSeparator: "," });
      expect(updated).toBeDefined();
      expect(updated!.scopeSeparator).toBe(",");

      const fetched = getProvider("github");
      expect(fetched!.scopeSeparator).toBe(",");
    });

    test("coerces empty-string scopeSeparator to default ' '", () => {
      // An empty separator would join scopes into a single concatenated token
      // (e.g. ["read","write"].join("") === "readwrite") which is never a
      // valid OAuth authorize URL value. Coerce to the default.
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
          scopeSeparator: ",",
        },
      ]);

      expect(getProvider("github")!.scopeSeparator).toBe(",");

      const updated = updateProvider("github", { scopeSeparator: "" });
      expect(updated).toBeDefined();
      expect(updated!.scopeSeparator).toBe(" ");
      expect(getProvider("github")!.scopeSeparator).toBe(" ");
    });

    test("sets refreshUrl on an existing row where it was previously null", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const before = getProvider("github");
      expect(before!.refreshUrl).toBeNull();

      const updated = updateProvider("github", {
        refreshUrl: "https://github.com/login/oauth/refresh",
      });
      expect(updated).toBeDefined();
      expect(updated!.refreshUrl).toBe(
        "https://github.com/login/oauth/refresh",
      );

      const fetched = getProvider("github");
      expect(fetched!.refreshUrl).toBe(
        "https://github.com/login/oauth/refresh",
      );
    });

    test("leaves refreshUrl unchanged when not passed to updateProvider", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          refreshUrl: "https://github.com/login/oauth/refresh",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      expect(getProvider("github")!.refreshUrl).toBe(
        "https://github.com/login/oauth/refresh",
      );

      // Update a different field — refreshUrl should be left alone.
      const updated = updateProvider("github", {
        displayLabel: "GitHub (updated)",
      });
      expect(updated).toBeDefined();
      expect(updated!.refreshUrl).toBe(
        "https://github.com/login/oauth/refresh",
      );
      expect(updated!.displayLabel).toBe("GitHub (updated)");
    });

    test("sets revokeUrl on an existing row where it was previously null", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const before = getProvider("github");
      expect(before!.revokeUrl).toBeNull();

      const updated = updateProvider("github", {
        revokeUrl: "https://github.com/login/oauth/revoke",
      });
      expect(updated).toBeDefined();
      expect(updated!.revokeUrl).toBe("https://github.com/login/oauth/revoke");

      const fetched = getProvider("github");
      expect(fetched!.revokeUrl).toBe("https://github.com/login/oauth/revoke");
    });

    test("sets revokeBodyTemplate on an existing row and JSON round-trips", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      const before = getProvider("github");
      expect(before!.revokeBodyTemplate).toBeNull();

      const updated = updateProvider("github", {
        revokeBodyTemplate: {
          token: "{access_token}",
          client_id: "{client_id}",
        },
      });
      expect(updated).toBeDefined();
      expect(JSON.parse(updated!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
        client_id: "{client_id}",
      });

      const fetched = getProvider("github");
      expect(JSON.parse(fetched!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
        client_id: "{client_id}",
      });
    });

    test("leaves revokeUrl and revokeBodyTemplate unchanged when not passed to updateProvider", () => {
      seedProviders([
        {
          provider: "github",
          authorizeUrl: "https://github.com/authorize",
          tokenExchangeUrl: "https://github.com/token",
          revokeUrl: "https://github.com/login/oauth/revoke",
          revokeBodyTemplate: { token: "{access_token}" },
          defaultScopes: ["repo"],
          scopePolicy: {},
        },
      ]);

      expect(getProvider("github")!.revokeUrl).toBe(
        "https://github.com/login/oauth/revoke",
      );
      expect(JSON.parse(getProvider("github")!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });

      // Update a different field — revoke fields should be left alone.
      const updated = updateProvider("github", {
        displayLabel: "GitHub (updated)",
      });
      expect(updated).toBeDefined();
      expect(updated!.revokeUrl).toBe("https://github.com/login/oauth/revoke");
      expect(JSON.parse(updated!.revokeBodyTemplate!)).toEqual({
        token: "{access_token}",
      });
      expect(updated!.displayLabel).toBe("GitHub (updated)");
    });

    test("coerces empty string tokenEndpointAuthMethod to client_secret_post", () => {
      seedProviders([
        {
          provider: "update-empty-test",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          tokenEndpointAuthMethod: "client_secret_basic",
          defaultScopes: [],
          scopePolicy: {},
        },
      ]);

      expect(getProvider("update-empty-test")!.tokenEndpointAuthMethod).toBe(
        "client_secret_basic",
      );

      const updated = updateProvider("update-empty-test", {
        tokenEndpointAuthMethod: "",
      });
      expect(updated).toBeDefined();
      expect(updated!.tokenEndpointAuthMethod).toBe("client_secret_post");

      const row = getProvider("update-empty-test");
      expect(row!.tokenEndpointAuthMethod).toBe("client_secret_post");
    });

    test("coerces empty string tokenExchangeBodyFormat to 'form'", () => {
      seedProviders([
        {
          provider: "update-empty-body-format-test",
          authorizeUrl: "https://example.com/authorize",
          tokenExchangeUrl: "https://example.com/token",
          tokenExchangeBodyFormat: "json",
          defaultScopes: [],
          scopePolicy: {},
        },
      ]);

      expect(
        getProvider("update-empty-body-format-test")!.tokenExchangeBodyFormat,
      ).toBe("json");

      const updated = updateProvider("update-empty-body-format-test", {
        tokenExchangeBodyFormat: "",
      });
      expect(updated).toBeDefined();
      expect(updated!.tokenExchangeBodyFormat).toBe("form");

      const row = getProvider("update-empty-body-format-test");
      expect(row!.tokenExchangeBodyFormat).toBe("form");
    });

    test("sets logoUrl on an existing row where it was previously null", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      });

      expect(getProvider("linear")!.logoUrl).toBeNull();

      const updated = updateProvider("linear", {
        logoUrl: "https://cdn.simpleicons.org/linear",
      });
      expect(updated).toBeDefined();
      expect(updated!.logoUrl).toBe("https://cdn.simpleicons.org/linear");

      const fetched = getProvider("linear");
      expect(fetched!.logoUrl).toBe("https://cdn.simpleicons.org/linear");
    });

    test("clears logoUrl when passed null", () => {
      registerProvider({
        provider: "notion",
        authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        logoUrl: "https://cdn.simpleicons.org/notion",
      });

      expect(getProvider("notion")!.logoUrl).toBe(
        "https://cdn.simpleicons.org/notion",
      );

      const updated = updateProvider("notion", { logoUrl: null });
      expect(updated).toBeDefined();
      expect(updated!.logoUrl).toBeNull();

      expect(getProvider("notion")!.logoUrl).toBeNull();
    });

    test("leaves logoUrl unchanged when not passed to updateProvider", () => {
      registerProvider({
        provider: "notion",
        authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        logoUrl: "https://cdn.simpleicons.org/notion",
      });

      expect(getProvider("notion")!.logoUrl).toBe(
        "https://cdn.simpleicons.org/notion",
      );

      // Update a different field — logoUrl should be left alone.
      const updated = updateProvider("notion", {
        displayLabel: "Notion (updated)",
      });
      expect(updated).toBeDefined();
      expect(updated!.logoUrl).toBe("https://cdn.simpleicons.org/notion");
      expect(updated!.displayLabel).toBe("Notion (updated)");
    });
  });

  describe("scopeSeparator empty-string coercion", () => {
    test("seedProviders coerces empty-string scopeSeparator to ' '", () => {
      seedProviders([
        {
          provider: "linear",
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenExchangeUrl: "https://api.linear.app/oauth/token",
          defaultScopes: ["read"],
          scopePolicy: {},
          scopeSeparator: "",
        },
      ]);

      const row = getProvider("linear");
      expect(row!.scopeSeparator).toBe(" ");
    });

    test("registerProvider coerces empty-string scopeSeparator to ' '", () => {
      registerProvider({
        provider: "linear",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenExchangeUrl: "https://api.linear.app/oauth/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        scopeSeparator: "",
      });

      const row = getProvider("linear");
      expect(row!.scopeSeparator).toBe(" ");
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
      expect(app.provider).toBe("github");
      expect(app.clientId).toBe("client-abc");
      expect(app.createdAt).toBeGreaterThan(0);
      expect(app.updatedAt).toBeGreaterThan(0);
    });

    test("returns the existing app when called again with same (provider, clientId)", async () => {
      seedTestProvider("github");
      const first = await upsertApp("github", "client-abc");
      const second = await upsertApp("github", "client-abc");

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });

    test("stores clientSecret in secure storage on new app creation", async () => {
      seedTestProvider("github");
      const app = await upsertApp("github", "client-abc", {
        clientSecretValue: "my-secret",
      });

      expect(mockSetSecureKeyAsync).toHaveBeenCalledTimes(1);
      expect(mockSetSecureKeyAsync).toHaveBeenCalledWith(
        `oauth_app/${app.id}/client_secret`,
        "my-secret",
      );
      expect(app.clientSecretCredentialPath).toBe(
        `oauth_app/${app.id}/client_secret`,
      );
    });

    test("stores clientSecret in secure storage when upserting an existing app", async () => {
      seedTestProvider("github");
      const first = await upsertApp("github", "client-abc");
      mockSetSecureKeyAsync.mockClear();

      await upsertApp("github", "client-abc", {
        clientSecretValue: "updated-secret",
      });

      expect(mockSetSecureKeyAsync).toHaveBeenCalledTimes(1);
      expect(mockSetSecureKeyAsync).toHaveBeenCalledWith(
        first.clientSecretCredentialPath,
        "updated-secret",
      );
    });

    test("throws when setSecureKeyAsync returns false", async () => {
      seedTestProvider("github");
      mockSetSecureKeyAsync.mockResolvedValueOnce(false);

      await expect(
        upsertApp("github", "client-abc", { clientSecretValue: "bad-secret" }),
      ).rejects.toThrow("Failed to store client_secret in secure storage");
    });

    test("accepts clientSecretCredentialPath and verifies existence", async () => {
      seedTestProvider("github");
      secureKeyValues.set("custom/path", "stored-secret");

      const app = await upsertApp("github", "client-abc", {
        clientSecretCredentialPath: "custom/path",
      });

      expect(app.clientSecretCredentialPath).toBe("custom/path");
      // Should not have called setSecureKeyAsync since we only provided a path
      expect(mockSetSecureKeyAsync).not.toHaveBeenCalled();
    });

    test("throws when clientSecretCredentialPath points to nonexistent secret", async () => {
      seedTestProvider("github");

      await expect(
        upsertApp("github", "client-abc", {
          clientSecretCredentialPath: "nonexistent/path",
        }),
      ).rejects.toThrow("No secret found at credential path: nonexistent/path");
    });

    test("throws when both clientSecretValue and clientSecretCredentialPath are provided", async () => {
      seedTestProvider("github");

      await expect(
        upsertApp("github", "client-abc", {
          clientSecretValue: "my-secret",
          clientSecretCredentialPath: "custom/path",
        }),
      ).rejects.toThrow(
        "Cannot provide both clientSecretValue and clientSecretCredentialPath",
      );
    });

    test("records default clientSecretCredentialPath when neither value nor path is provided", async () => {
      seedTestProvider("github");
      const app = await upsertApp("github", "client-abc");

      expect(app.clientSecretCredentialPath).toBe(
        `oauth_app/${app.id}/client_secret`,
      );
    });

    test("updates clientSecretCredentialPath on existing row when path is provided", async () => {
      seedTestProvider("github");
      const first = await upsertApp("github", "client-abc");
      expect(first.clientSecretCredentialPath).toBe(
        `oauth_app/${first.id}/client_secret`,
      );

      secureKeyValues.set("new/custom/path", "stored-secret");
      const updated = await upsertApp("github", "client-abc", {
        clientSecretCredentialPath: "new/custom/path",
      });

      expect(updated.id).toBe(first.id);
      expect(updated.clientSecretCredentialPath).toBe("new/custom/path");
    });
  });

  describe("getApp", () => {
    test("returns the correct row by id", async () => {
      const app = await createTestApp("github", "client-1");
      const fetched = getApp(app.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(app.id);
      expect(fetched!.provider).toBe("github");
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

    test("cleans up client_secret from secure storage using stored path", async () => {
      const app = await createTestApp("github", "client-1");
      mockDeleteSecureKeyAsync.mockClear();

      await deleteApp(app.id);

      expect(mockDeleteSecureKeyAsync).toHaveBeenCalledWith(
        app.clientSecretCredentialPath,
      );
    });

    test("uses custom clientSecretCredentialPath when deleting", async () => {
      seedTestProvider("github");
      secureKeyValues.set("custom/secret/path", "the-secret");
      const app = await upsertApp("github", "client-1", {
        clientSecretCredentialPath: "custom/secret/path",
      });
      mockDeleteSecureKeyAsync.mockClear();

      await deleteApp(app.id);

      expect(mockDeleteSecureKeyAsync).toHaveBeenCalledWith(
        "custom/secret/path",
      );
    });

    test("returns false for nonexistent id", async () => {
      expect(await deleteApp("nonexistent-id")).toBe(false);
    });

    test("throws when deleteSecureKeyAsync returns error", async () => {
      const app = await createTestApp("github", "client-1");
      mockDeleteSecureKeyAsync.mockResolvedValueOnce("error");

      await expect(deleteApp(app.id)).rejects.toThrow(
        /failed to remove client_secret from secure storage/i,
      );

      // DB row should already be deleted (delete happens before secure key cleanup)
      expect(getApp(app.id)).toBeUndefined();
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
        provider: "github",
        grantedScopes: ["repo", "user"],
        hasRefreshToken: true,
        accountInfo: "user@example.com",
        label: "Primary GitHub",
        metadata: { login: "octocat" },
      });

      expect(conn.id).toBeTruthy();
      expect(conn.oauthAppId).toBe(app.id);
      expect(conn.provider).toBe("github");
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
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const fetched = getConnection(conn.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(conn.id);
      expect(fetched!.provider).toBe("github");
    });

    test("returns undefined for unknown id", () => {
      expect(getConnection("nonexistent-id")).toBeUndefined();
    });
  });

  describe("getActiveConnection", () => {
    test("returns the most recent active connection with no filters", async () => {
      const app = await createTestApp("github", "client-1");

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo", "user"],
        hasRefreshToken: true,
        createdAt: 2000,
      });

      const result = getActiveConnection("github");
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn2.id);
    });

    test("narrows by account when provided", async () => {
      const app = await createTestApp("github", "client-1");

      const conn1 = createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user1@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user2@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 2000,
      });

      const result = getActiveConnection("github", {
        account: "user1@example.com",
      });
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn1.id);
    });

    test("narrows by clientId when provided", async () => {
      const app1 = await createTestApp("github", "client-a");
      const app2 = await createTestApp("github", "client-b");

      const conn1 = createConnection({
        oauthAppId: app1.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      createConnection({
        oauthAppId: app2.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 2000,
      });

      const result = getActiveConnection("github", { clientId: "client-a" });
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn1.id);
    });

    test("returns undefined when clientId has no matching app", async () => {
      const app = await createTestApp("github", "client-1");

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const result = getActiveConnection("github", {
        clientId: "nonexistent",
      });
      expect(result).toBeUndefined();
    });

    test("skips revoked connections", async () => {
      const app = await createTestApp("github", "client-1");

      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      updateConnection(conn.id, { status: "revoked" });

      const result = getActiveConnection("github");
      expect(result).toBeUndefined();
    });

    test("returns undefined when no connections exist", () => {
      expect(getActiveConnection("github")).toBeUndefined();
    });
  });

  describe("getConnectionByProvider", () => {
    test("returns the most recent active connection", async () => {
      const app = await createTestApp("github", "client-1");

      // Create two connections with explicit timestamps so ordering is deterministic
      createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        provider: "github",
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
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        provider: "github",
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
        provider: "github",
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

  describe("getConnectionByProviderAndAccount", () => {
    test("returns the connection matching the given account", async () => {
      const app = await createTestApp("github", "client-1");

      const conn1 = createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user1@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 1000,
      });

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user2@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
        createdAt: 2000,
      });

      const result = getConnectionByProviderAndAccount(
        "github",
        "user1@example.com",
      );
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn1.id);
    });

    test("falls back to getConnectionByProvider when accountInfo is undefined", async () => {
      const app = await createTestApp("github", "client-1");

      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const result = getConnectionByProviderAndAccount("github", undefined);
      expect(result).toBeDefined();
      expect(result!.id).toBe(conn.id);
    });

    test("returns undefined when no connection matches the account", async () => {
      const app = await createTestApp("github", "client-1");

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const result = getConnectionByProviderAndAccount(
        "github",
        "other@example.com",
      );
      expect(result).toBeUndefined();
    });

    test("skips revoked connections", async () => {
      const app = await createTestApp("github", "client-1");

      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      updateConnection(conn.id, { status: "revoked" });

      const result = getConnectionByProviderAndAccount(
        "github",
        "user@example.com",
      );
      expect(result).toBeUndefined();
    });
  });

  describe("listActiveConnectionsByProvider", () => {
    test("returns all active connections for a provider", async () => {
      const app = await createTestApp("github", "client-1");

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user1@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user2@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const results = listActiveConnectionsByProvider("github");
      expect(results).toHaveLength(2);
    });

    test("excludes revoked connections", async () => {
      const app = await createTestApp("github", "client-1");

      createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user1@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      const conn2 = createConnection({
        oauthAppId: app.id,
        provider: "github",
        accountInfo: "user2@example.com",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      updateConnection(conn2.id, { status: "revoked" });

      const results = listActiveConnectionsByProvider("github");
      expect(results).toHaveLength(1);
      expect(results[0]!.accountInfo).toBe("user1@example.com");
    });

    test("returns empty array when no active connections exist", () => {
      const results = listActiveConnectionsByProvider("github");
      expect(results).toHaveLength(0);
    });
  });

  describe("isProviderConnected", () => {
    test("returns true when active connection has an access token in secure storage", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "tok");

      expect(await isProviderConnected("github")).toBe(true);
    });

    test("returns false when active connection exists but access token is missing", async () => {
      const app = await createTestApp("github", "client-1");
      createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      // No secure key set — simulates failed token write
      expect(await isProviderConnected("github")).toBe(false);
    });

    test("returns false when no connection exists", async () => {
      expect(await isProviderConnected("github")).toBe(false);
    });

    test("returns false when connection is revoked even with token in store", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });

      updateConnection(conn.id, { status: "revoked" });
      secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "tok");

      expect(await isProviderConnected("github")).toBe(false);
    });
  });

  describe("updateConnection", () => {
    test("modifies specific fields", async () => {
      const app = await createTestApp("github", "client-1");
      const conn = createConnection({
        oauthAppId: app.id,
        provider: "github",
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
        provider: "github",
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
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      createConnection({
        oauthAppId: googApp.id,
        provider: "google",
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
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      });
      createConnection({
        oauthAppId: googApp.id,
        provider: "google",
        grantedScopes: ["email"],
        hasRefreshToken: true,
      });

      const ghConns = listConnections("github");
      expect(ghConns).toHaveLength(1);
      expect(ghConns[0].provider).toBe("github");

      const googConns = listConnections("google");
      expect(googConns).toHaveLength(1);
      expect(googConns[0].provider).toBe("google");
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
        provider: "github",
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
  /**
   * Seed a provider with revokeUrl and (optionally) a revokeBodyTemplate.
   */
  function seedProviderWithRevoke(
    provider: string,
    revokeUrl: string | null,
    revokeBodyTemplate?: Record<string, string>,
  ): void {
    seedProviders([
      {
        provider,
        authorizeUrl: `https://${provider}.example.com/authorize`,
        tokenExchangeUrl: `https://${provider}.example.com/token`,
        defaultScopes: ["read"],
        scopePolicy: {},
        ...(revokeUrl ? { revokeUrl } : {}),
        ...(revokeBodyTemplate ? { revokeBodyTemplate } : {}),
      },
    ]);
  }

  test("returns 'not-found' when no connection exists for the provider", async () => {
    const result = await disconnectOAuthProvider("github");
    expect(result).toBe("not-found");
    expect(mockDeleteSecureKeyAsync).not.toHaveBeenCalled();
    // No upstream call should be made when there is no connection at all.
    expect(getMockFetchCalls().length).toBe(0);
  });

  test("returns 'disconnected' and deletes connection row and secure keys when connection exists", async () => {
    const app = await createTestApp("github", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "github",
      grantedScopes: ["repo"],
      hasRefreshToken: true,
    });

    const result = await disconnectOAuthProvider("github");
    expect(result).toBe("disconnected");

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

  test("calls upstream revoke when provider has revokeUrl and access token exists", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
      client_id: "{client_id}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: true,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "fake-token-xyz",
    );

    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      { status: 200, body: {} },
    );

    const result = await disconnectOAuthProvider("google");
    expect(result).toBe("disconnected");

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.path).toContain("https://oauth2.googleapis.com/revoke");

    const body = String(calls[0]!.init.body ?? "");
    const params = new URLSearchParams(body);
    expect(params.get("token")).toBe("fake-token-xyz");
    expect(params.get("client_id")).toBe("client-1");
  });

  test("skips upstream revoke when provider has no revokeUrl", async () => {
    // GitHub seeded by createTestApp via seedTestProvider — no revokeUrl.
    const app = await createTestApp("github", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "github",
      grantedScopes: ["repo"],
      hasRefreshToken: false,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "github-token",
    );

    const result = await disconnectOAuthProvider("github");
    expect(result).toBe("disconnected");
    expect(getMockFetchCalls().length).toBe(0);
  });

  test("skips upstream revoke when no access token exists in secure storage", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
    });
    const app = await upsertApp("google", "client-1");
    createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: false,
    });
    // No access token seeded into secureKeyValues.

    const result = await disconnectOAuthProvider("google");
    expect(result).toBe("disconnected");
    expect(getMockFetchCalls().length).toBe(0);
  });

  test("continues local cleanup when upstream revoke returns non-2xx", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: true,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "fake-token-xyz",
    );

    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      { status: 400, body: { error: "invalid_token" } },
    );

    const result = await disconnectOAuthProvider("google");
    expect(result).toBe("disconnected");
    expect(getMockFetchCalls().length).toBe(1);
    // Local cleanup still happened
    expect(mockDeleteSecureKeyAsync).toHaveBeenCalledWith(
      `oauth_connection/${conn.id}/access_token`,
    );
    expect(getConnection(conn.id)).toBeUndefined();
  });

  test("continues local cleanup when upstream revoke throws (network error)", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: true,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "fake-token-xyz",
    );

    // 500 exercises the same swallow path as a network error.
    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      { status: 500, body: { error: "server_error" } },
    );

    const result = await disconnectOAuthProvider("google");
    expect(result).toBe("disconnected");
    expect(getConnection(conn.id)).toBeUndefined();
  });

  test("substitutes {access_token} and {client_id} in body template values", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
      client_id: "{client_id}",
      token_type_hint: "access_token",
    });
    const app = await upsertApp("google", "client-substitution");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: false,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "tok-substitution",
    );

    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      { status: 200, body: {} },
    );

    await disconnectOAuthProvider("google");

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    const body = String(calls[0]!.init.body ?? "");
    const params = new URLSearchParams(body);
    expect(params.get("token")).toBe("tok-substitution");
    expect(params.get("client_id")).toBe("client-substitution");
    expect(params.get("token_type_hint")).toBe("access_token");
  });

  test("treats $-prefixed patterns in access token as literal text (String.replace gotcha)", async () => {
    // String.prototype.replace interprets $-prefixed patterns in the
    // replacement string as special sequences ($& = matched substring,
    // $' = after match, $` = before match, $$ = literal $). If the access
    // token contains "$&", a naive `.replace("{access_token}", accessToken)`
    // would expand it to "{access_token}" (the matched string) instead of
    // substituting literally. This test guards against that by asserting
    // the captured body contains the literal "tok$&abc" — which only holds
    // when we use a function-replacement callback that preserves literal
    // semantics and mirrors Python's str.replace() behavior.
    seedProviderWithRevoke("google", "https://revoke.example.com/r", {
      token: "{access_token}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: false,
    });
    secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "tok$&abc");

    mockFetch(
      "https://revoke.example.com/r",
      { method: "POST" },
      { status: 200, body: {} },
    );

    await disconnectOAuthProvider("google");

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    const body = String(calls[0]!.init.body ?? "");
    const params = new URLSearchParams(body);
    // The literal access token — not the $&-expanded version, which would
    // be "tok{access_token}abc" (where $& matched "{access_token}").
    expect(params.get("token")).toBe("tok$&abc");
  });

  test("replaces all occurrences of {access_token} in body template values (matching Python str.replace)", async () => {
    // Python's str.replace(old, new) replaces ALL occurrences by default,
    // whereas JavaScript's String.prototype.replace with a string pattern
    // only replaces the FIRST occurrence. The platform's try_revoke_token
    // is implemented in Python, so any template value containing repeated
    // placeholders must have ALL of them substituted to preserve parity.
    // This test guards against a regression to .replace(), which would
    // leave the second {access_token} as a literal placeholder.
    seedProviderWithRevoke("google", "https://revoke.example.com/r", {
      token: "token={access_token}&also={access_token}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: false,
    });
    secureKeyValues.set(`oauth_connection/${conn.id}/access_token`, "fake-abc");

    mockFetch(
      "https://revoke.example.com/r",
      { method: "POST" },
      { status: 200, body: {} },
    );

    await disconnectOAuthProvider("google");

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    const body = String(calls[0]!.init.body ?? "");
    const params = new URLSearchParams(body);
    // Both {access_token} placeholders must be substituted. With the buggy
    // .replace() (single-occurrence), this would be
    // "token=fake-abc&also={access_token}" instead.
    expect(params.get("token")).toBe("token=fake-abc&also=fake-abc");
  });

  test("coerces non-string body template values to strings", async () => {
    // seedProviderWithRevoke restricts to Record<string, string>; bypass it
    // here by inserting a template with a numeric value via a direct seed.
    seedProviders([
      {
        provider: "google",
        authorizeUrl: "https://google.example.com/authorize",
        tokenExchangeUrl: "https://google.example.com/token",
        defaultScopes: ["email"],
        scopePolicy: {},
        revokeUrl: "https://oauth2.googleapis.com/revoke",
        revokeBodyTemplate: {
          token: "{access_token}",
          // expires_in is a number — must be coerced via String(value).
          expires_in: 3600,
        } as unknown as Record<string, string>,
      },
    ]);
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: false,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "fake-token-xyz",
    );

    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      { status: 200, body: {} },
    );

    await disconnectOAuthProvider("google");

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    const body = String(calls[0]!.init.body ?? "");
    const params = new URLSearchParams(body);
    expect(params.get("token")).toBe("fake-token-xyz");
    expect(params.get("expires_in")).toBe("3600");
  });

  test("revokes BEFORE deleting tokens from secure storage", async () => {
    seedProviderWithRevoke("google", "https://oauth2.googleapis.com/revoke", {
      token: "{access_token}",
    });
    const app = await upsertApp("google", "client-1");
    const conn = createConnection({
      oauthAppId: app.id,
      provider: "google",
      grantedScopes: ["email"],
      hasRefreshToken: true,
    });
    secureKeyValues.set(
      `oauth_connection/${conn.id}/access_token`,
      "fake-token-xyz",
    );

    const order: string[] = [];

    // Wrap the mockFetch entry's response handler by registering a fetch
    // mock that records the call order via the existing mockFetch helper.
    // The mock fetch records to getMockFetchCalls; we tag ordering by
    // pushing a marker as soon as the response is constructed below.
    mockFetch(
      "https://oauth2.googleapis.com/revoke",
      { method: "POST" },
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Wrap delete to record its order. We replace the mock implementation
    // for the duration of this test only.
    mockDeleteSecureKeyAsync.mockImplementation(() => {
      order.push("delete");
      return Promise.resolve("deleted" as const);
    });

    // Wrap fetch one more layer: tap into the actual fetch call to record
    // ordering. We do this by overriding globalThis.fetch with a wrapper
    // that calls through to the existing mock and records ordering first.
    const wrappedFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      order.push("fetch");
      return wrappedFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const result = await disconnectOAuthProvider("google");
      expect(result).toBe("disconnected");
    } finally {
      // Restore the wrapper layer; resetMockFetch in beforeEach will reset
      // the underlying mock for the next test.
      globalThis.fetch = wrappedFetch;
      mockDeleteSecureKeyAsync.mockImplementation(
        (): Promise<"deleted" | "not-found" | "error"> =>
          Promise.resolve("deleted" as const),
      );
    }

    expect(order[0]).toBe("fetch");
    expect(order).toContain("delete");
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("delete"));
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
        provider: "github",
        grantedScopes: ["repo"],
        hasRefreshToken: false,
      }),
    ).toThrow();
  });
});
