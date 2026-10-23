/**
 * Tests for the OAuth proxy grant route (`oauth_proxy_grant`).
 *
 * The grant is a credential, so the guarantees under test are the ones a
 * leaked or misdirected grant would break: it verifies only under the subject
 * of the provider it names, it opens the passthrough route and nothing wider,
 * its base URL points at the connection the CLI will actually reach, and the
 * token never appears in a log line.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../../../oauth/connection.js";
import type { RouteError } from "../errors.js";

// ── Module mocks ────────────────────────────────────────────────────────────

const providerLookups: string[] = [];
mock.module("../../../oauth/oauth-store.js", () => ({
  getProvider: (provider: string) => {
    providerLookups.push(provider);
    // "vendor:eu" stands in for a custom provider key, which is caller-chosen
    // and unconstrained.
    return provider === "stripe_link" || provider === "vendor:eu"
      ? { provider, baseUrl: "https://api.link.com" }
      : undefined;
  },
}));

interface ResolverCall {
  provider: string;
  options: { account?: string } | undefined;
}
const resolverCalls: ResolverCall[] = [];
let resolverError: unknown;
let resolution: {
  connection: OAuthConnection;
  ambiguous: boolean;
  allAccounts: string[];
};

mock.module("../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnectionWithMeta: async (
    provider: string,
    options?: { account?: string },
  ) => {
    resolverCalls.push({ provider, options });
    if (resolverError) {
      throw resolverError;
    }
    return resolution;
  },
}));

// Spread the real module so the rest of the import graph keeps its env
// readers; only the gateway base and the auth bypass are pinned.
const env = await import("../../../config/env.js");
mock.module("../../../config/env.js", () => ({
  ...env,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  isHttpAuthDisabled: () => false,
}));

const logCalls: unknown[][] = [];
const realLogger = await import("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        () =>
        (...args: unknown[]) => {
          logCalls.push(args);
        },
    }),
}));

const { authenticateRequest } = await import("../../auth/middleware.js");
const { enforcePolicy, LOCAL_PRINCIPALS } =
  await import("../../auth/route-policy.js");
const { initAuthSigningKey, verifyToken } =
  await import("../../auth/token-service.js");
const { handleOAuthProxyGrant, ROUTES } =
  await import("../oauth-proxy-grant-routes.js");
const { ROUTES: PROXY_ROUTES } = await import("../oauth-proxy-routes.js");

// ── Harness ─────────────────────────────────────────────────────────────────

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

function connection(accountInfo: string | null): OAuthConnection {
  return {
    id: "conn-byo",
    provider: "stripe_link",
    accountInfo,
    request: async () => {
      throw new Error("the grant route never calls the provider");
    },
    async withToken() {
      throw new Error("the grant route never unwraps the raw token");
    },
  };
}

type Grant = Awaited<ReturnType<typeof handleOAuthProxyGrant>>;

async function grant(body: Record<string, unknown>): Promise<Grant> {
  return await handleOAuthProxyGrant({ body });
}

async function grantError(body: Record<string, unknown>): Promise<RouteError> {
  try {
    await grant(body);
  } catch (err) {
    return err as RouteError;
  }
  throw new Error("Expected the grant to be refused");
}

function claimsOf(token: string): {
  sub: string;
  scope_profile: string;
  exp: number;
} {
  const result = verifyToken(token, "vellum-gateway");
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.claims;
}

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
  providerLookups.length = 0;
  resolverCalls.length = 0;
  logCalls.length = 0;
  resolverError = undefined;
  resolution = {
    connection: connection("user@example.com"),
    ambiguous: false,
    allAccounts: ["user@example.com"],
  };
});

// ── Minted grant ────────────────────────────────────────────────────────────

describe("the minted grant", () => {
  test("verifies under the resolved connection's subject with the proxy profile", async () => {
    const result = await grant({ provider: "stripe_link" });

    const claims = claimsOf(result.token);
    expect(claims.sub).toBe(
      "local:self:oauth-proxy.stripe_link@user%40example.com",
    );
    expect(claims.scope_profile).toBe("oauth_proxy_v1");

    const expectedExp = Math.floor(Date.now() / 1000) + 900;
    expect(Math.abs(claims.exp - expectedExp)).toBeLessThanOrEqual(2);
  });

  test("the subject names the same segment the base URL points at", async () => {
    const result = await grant({
      provider: "stripe_link",
      account: "other user@example.com",
    });

    expect(claimsOf(result.token).sub).toBe(
      "local:self:oauth-proxy.stripe_link@other%20user%40example.com",
    );
    expect(result.path).toBe(
      "/v1/oauth/proxy/stripe_link@other%20user%40example.com",
    );
  });

  test("a grant for a second account gets a subject of its own", async () => {
    // generic-examples:ignore-next-line — reason: deliberately different accounts to test distinct subjects
    const first = await grant({ provider: "stripe_link", account: "a@x.test" });
    const second = await grant({
      provider: "stripe_link",
      // generic-examples:ignore-next-line — reason: deliberately different accounts to test distinct subjects
      account: "b@x.test",
    });

    expect(claimsOf(first.token).sub).not.toBe(claimsOf(second.token).sub);
  });

  test("an unpinned grant keeps the bare provider subject", async () => {
    resolution = { ...resolution, connection: connection(null) };

    const result = await grant({ provider: "stripe_link" });

    expect(claimsOf(result.token).sub).toBe(
      "local:self:oauth-proxy.stripe_link",
    );
  });

  test("every minted subject stays a three-component local sub", async () => {
    for (const account of [undefined, "a:b@example.com", "a/b", "a b"]) {
      const result = await grant({
        provider: "stripe_link",
        ...(account && { account }),
      });
      expect(claimsOf(result.token).sub.split(":")).toHaveLength(3);
    }
  });

  test("points the base URL at the resolved account's provider segment", async () => {
    const result = await grant({ provider: "stripe_link" });

    expect(result).toMatchObject({
      ok: true,
      provider: "stripe_link",
      account: "user@example.com",
      path: "/v1/oauth/proxy/stripe_link@user%40example.com",
      baseUrl:
        "http://127.0.0.1:7830/v1/oauth/proxy/stripe_link@user%40example.com",
      ttlSeconds: 900,
    });
    expect(result.expiresAt).toBe(
      new Date(Date.parse(result.expiresAt)).toISOString(),
    );
  });

  test("an explicit account wins over the resolved label and is encoded", async () => {
    const result = await grant({
      provider: "stripe_link",
      account: "other user@example.com",
    });

    expect(resolverCalls).toEqual([
      {
        provider: "stripe_link",
        options: { account: "other user@example.com" },
      },
    ]);
    expect(result.account).toBe("other user@example.com");
    expect(result.path).toBe(
      "/v1/oauth/proxy/stripe_link@other%20user%40example.com",
    );
  });

  test("pins an unlabeled connection selected by ID", async () => {
    resolution = { ...resolution, connection: connection(null) };
    const result = await grant({
      provider: "stripe_link",
      account: "conn-byo",
    });

    expect(resolverCalls).toEqual([
      { provider: "stripe_link", options: { account: "conn-byo" } },
    ]);
    expect(result.account).toBe("conn-byo");
    expect(result.path).toBe("/v1/oauth/proxy/stripe_link@conn-byo");
    expect(claimsOf(result.token).sub).toBe(
      "local:self:oauth-proxy.stripe_link@conn-byo",
    );
  });

  test("leaves the segment unpinned when nothing names an account", async () => {
    resolution = { ...resolution, connection: connection(null) };

    const result = await grant({ provider: "stripe_link" });

    expect(resolverCalls).toEqual([
      { provider: "stripe_link", options: undefined },
    ]);
    expect(result.account).toBeNull();
    expect(result.path).toBe("/v1/oauth/proxy/stripe_link");
    expect(result.baseUrl).toBe(
      "http://127.0.0.1:7830/v1/oauth/proxy/stripe_link",
    );
  });

  test("never writes the token to a log line", async () => {
    const result = await grant({ provider: "stripe_link" });

    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(result.token);
    expect(logCalls.at(-1)?.[0]).toEqual({
      provider: "stripe_link",
      account: "user@example.com",
      ttlSeconds: 900,
    });
  });
});

// ── Request validation ──────────────────────────────────────────────────────

describe("request validation", () => {
  test.each([60, 3600])("accepts a ttlSeconds of %s", async (ttlSeconds) => {
    const result = await grant({ provider: "stripe_link", ttlSeconds });

    expect(result.ttlSeconds).toBe(ttlSeconds);
    const expectedExp = Math.floor(Date.now() / 1000) + ttlSeconds;
    expect(
      Math.abs(claimsOf(result.token).exp - expectedExp),
    ).toBeLessThanOrEqual(2);
  });

  test.each([59, 3601, 90.5])(
    "refuses a ttlSeconds of %s with 400",
    async (ttlSeconds) => {
      const err = await grantError({ provider: "stripe_link", ttlSeconds });

      expect(err.statusCode).toBe(400);
      expect(resolverCalls).toEqual([]);
    },
  );

  test("refuses a missing provider with 400", async () => {
    expect((await grantError({})).statusCode).toBe(400);
    expect((await grantError({ provider: "" })).statusCode).toBe(400);
    expect(providerLookups).toEqual([]);
  });

  test("refuses a registered provider key the subject cannot hold", async () => {
    // "vendor:eu" would mint a four-component local subject, which every
    // subject parser rejects, so the grant could never be used.
    const err = await grantError({ provider: "vendor:eu" });

    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("vendor:eu");
  });

  test("an account with a colon is encoded rather than refused", async () => {
    const result = await grant({
      provider: "stripe_link",
      account: "a:b@example.com",
    });

    expect(result.account).toBe("a:b@example.com");
    expect(result.path).toBe("/v1/oauth/proxy/stripe_link@a%3Ab%40example.com");
  });
});

// ── Connection failures ─────────────────────────────────────────────────────

describe("connection failures", () => {
  test("an unknown provider is a 404 before the resolver runs", async () => {
    const err = await grantError({ provider: "nope" });

    expect(err.statusCode).toBe(404);
    expect(resolverCalls).toEqual([]);
  });

  test("several connected accounts are a 409 naming each one", async () => {
    resolution = {
      connection: connection("a@example.com"),
      ambiguous: true,
      allAccounts: ["a@example.com", "b@example.com"],
    };

    const err = await grantError({ provider: "stripe_link" });

    expect(err.statusCode).toBe(409);
    expect(err.details).toMatchObject({
      provider: "stripe_link",
      accounts: ["a@example.com", "b@example.com"],
    });
  });

  test("a resolver failure is a 424 telling the caller to reconnect", async () => {
    resolverError = new Error("No active connection for stripe_link");

    const err = await grantError({ provider: "stripe_link" });

    expect(err.statusCode).toBe(424);
    expect(err.details).toMatchObject({
      reconnect: "assistant oauth connect stripe_link",
    });
  });
});

// ── Reach of the grant ──────────────────────────────────────────────────────

describe("what the grant opens", () => {
  function authContextFor(token: string) {
    const result = authenticateRequest(
      new Request(
        "http://daemon.local/v1/oauth/proxy/stripe_link/v1/accounts",
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("The grant did not authenticate");
    }
    return result.context;
  }

  test("passes the passthrough route's policy and no wider one", async () => {
    const { token } = await grant({ provider: "stripe_link" });
    const ctx = authContextFor(token);

    for (const route of PROXY_ROUTES) {
      expect(enforcePolicy(route.endpoint, route.policy, ctx)).toBeNull();
    }

    const denied = enforcePolicy(
      "oauth/proxy-grant",
      {
        requiredScopes: ["settings.write"],
        allowedPrincipalTypes: LOCAL_PRINCIPALS,
      },
      ctx,
    );
    expect(denied?.status).toBe(403);
  });

  test("the grant route itself is IPC-local and settings-scoped", () => {
    expect(ROUTES).toHaveLength(1);
    expect(ROUTES[0]).toMatchObject({
      operationId: "oauth_proxy_grant",
      endpoint: "oauth/proxy-grant",
      method: "POST",
      policy: {
        requiredScopes: ["settings.write"],
        allowedPrincipalTypes: LOCAL_PRINCIPALS,
      },
    });
  });
});
