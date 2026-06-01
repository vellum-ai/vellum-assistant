/**
 * Route handler tests for the OAuth CLI command endpoints exposed by
 * `assistant/src/runtime/routes/oauth-commands-routes.ts`.
 *
 * Scope: argument validation, provider / mode dispatch, and the shape of
 * returned payloads for the 9 endpoints (oauth_disconnect, oauth_mode_get,
 * oauth_mode_set, oauth_status, oauth_ping, oauth_token, oauth_request,
 * oauth_managed_connect_start, oauth_managed_connect_poll). These routes
 * back the thin IPC wrappers in `assistant/src/cli/commands/oauth/`.
 *
 * Deeper coverage of the underlying store / token-refresh / platform logic
 * lives in `oauth-store.test.ts`, `credential-vault.test.ts`, and the other
 * oauth-*-routes test files.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — flipped per-test in beforeEach hooks
// ---------------------------------------------------------------------------

interface MockProviderRow {
  provider: string;
  authorizeUrl: string;
  managedServiceConfigKey: string | null;
  baseUrl: string | null;
  injectionTemplates: string | null;
  pingUrl: string | null;
  pingMethod: string | null;
  pingHeaders: string | null;
  pingBody: string | null;
}

const baseProvider: MockProviderRow = {
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  managedServiceConfigKey: "google-oauth",
  baseUrl: "https://api.google.com",
  injectionTemplates: null,
  pingUrl: null,
  pingMethod: null,
  pingHeaders: null,
  pingBody: null,
};

let mockProviders: Record<string, MockProviderRow> = {};
let mockServiceModes: Record<string, "managed" | "your-own"> = {};
let mockActiveConnectionsByProvider: Record<string, unknown[]> = {};
let mockAllConnections: Record<string, unknown[]> = {};
let mockApps: Record<string, unknown> = {};
let mockTokenValue = "tok-fake";
let platformAvailable = true;
let platformAssistantId: string | null = "assistant-1";
let mockFetchImpl: (
  path: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}> = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "",
});
let mockResolveResponse: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
} = { status: 200, headers: {}, body: { ok: true } };
let mockResolveRequests: unknown[] = [];
let mockSyncManualTokenCalls: string[] = [];

const mockDisconnectOAuthProvider = mock(() => Promise.resolve());
const mockSaveRawConfig = mock(() => undefined);

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: mockDisconnectOAuthProvider,
  getActiveConnection: (
    provider: string,
    opts?: { clientId?: string; account?: string },
  ) => {
    const list = (mockActiveConnectionsByProvider[provider] ?? []) as Array<{
      id: string;
      clientId?: string;
      accountInfo?: string | null;
    }>;
    if (opts?.account) {
      return list.find((c) => c.accountInfo === opts.account);
    }
    if (opts?.clientId) {
      return list.find((c) => c.clientId === opts.clientId);
    }
    return list[0];
  },
  getAppByProviderAndClientId: (provider: string, clientId: string) => {
    return mockApps[`${provider}:${clientId}`];
  },
  getConnection: (id: string) => {
    for (const list of Object.values(mockAllConnections)) {
      const row = (list as Array<{ id: string }>).find((r) => r.id === id);
      if (row) return row;
    }
    return undefined;
  },
  getProvider: (provider: string) => mockProviders[provider],
  listActiveConnectionsByProvider: (provider: string) =>
    mockActiveConnectionsByProvider[provider] ?? [],
  listConnections: (provider: string) => mockAllConnections[provider] ?? [],
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (_provider: string) => ({
    request: async (req: unknown) => {
      mockResolveRequests.push(req);
      return mockResolveResponse;
    },
  }),
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: async (provider: string) => {
    mockSyncManualTokenCalls.push(provider);
  },
}));

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => {
      if (!platformAvailable) return null;
      return {
        platformAssistantId,
        fetch: (path: string, init?: RequestInit) => mockFetchImpl(path, init),
      };
    },
  },
}));

mock.module("../security/token-manager.js", () => ({
  withValidToken: async <T>(_provider: string, fn: (t: string) => Promise<T>) =>
    fn(mockTokenValue),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  loadRawConfig: () => ({ services: {} }),
  saveRawConfig: mockSaveRawConfig,
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    const parts = path.split(".");
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  },
}));

mock.module("../config/schemas/services.js", () => ({
  getServiceMode: (_services: unknown, key: string) =>
    mockServiceModes[key] ?? "your-own",
  ServicesSchema: {
    shape: {
      "google-oauth": true,
      "byo-only": true,
    },
  },
}));

import {
  BadRequestError,
  InternalError,
  NotFoundError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/oauth-commands-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

function getRoute(method: string, endpoint: string) {
  const route = ROUTES.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`Route not found: ${method} ${endpoint}`);
  return route;
}

function makeArgs(
  opts: {
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): RouteHandlerArgs {
  return {
    pathParams: opts.pathParams,
    queryParams: opts.queryParams,
    body: opts.body,
  };
}

beforeEach(() => {
  mockProviders = { google: { ...baseProvider } };
  mockServiceModes = {};
  mockActiveConnectionsByProvider = {};
  mockAllConnections = {};
  mockApps = {};
  mockTokenValue = "tok-fake";
  platformAvailable = true;
  platformAssistantId = "assistant-1";
  mockFetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  });
  mockResolveResponse = { status: 200, headers: {}, body: { ok: true } };
  mockResolveRequests = [];
  mockSyncManualTokenCalls = [];
  mockDisconnectOAuthProvider.mockClear();
  mockSaveRawConfig.mockClear();
});

// ---------------------------------------------------------------------------
// Route registry — establishes that all 9 endpoints are wired correctly.
// ---------------------------------------------------------------------------

describe("oauth-commands-routes route registry", () => {
  test("registers all 9 IPC endpoints", () => {
    const ops = ROUTES.map((r) => r.operationId).sort();
    expect(ops).toEqual([
      "oauth_disconnect",
      "oauth_managed_connect_poll",
      "oauth_managed_connect_start",
      "oauth_mode_get",
      "oauth_mode_set",
      "oauth_ping",
      "oauth_request",
      "oauth_status",
      "oauth_token",
    ]);
  });

  test("every route enforces policy", () => {
    for (const route of ROUTES) {
      expect(route.policy).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// POST oauth/disconnect
// ---------------------------------------------------------------------------

describe("POST oauth/disconnect", () => {
  test("rejects missing provider", async () => {
    await expect(
      getRoute("POST", "oauth/disconnect").handler(makeArgs({ body: {} })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects unknown provider", async () => {
    await expect(
      getRoute("POST", "oauth/disconnect").handler(
        makeArgs({ body: { provider: "unknown" } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects both account and connection_id", async () => {
    await expect(
      getRoute("POST", "oauth/disconnect").handler(
        makeArgs({
          body: {
            provider: "google",
            account: "alice@example.com",
            connection_id: "conn-1",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("BYO mode disconnects via oauth-store", async () => {
    mockActiveConnectionsByProvider.google = [
      { id: "conn-1", accountInfo: "alice@example.com" },
    ];
    const result = (await getRoute("POST", "oauth/disconnect").handler(
      makeArgs({ body: { provider: "google" } }),
    )) as { ok: boolean; connectionId: string };
    expect(result.ok).toBe(true);
    expect(result.connectionId).toBe("conn-1");
    expect(mockDisconnectOAuthProvider).toHaveBeenCalledTimes(1);
  });

  test("managed mode with no active connections raises NotFound", async () => {
    mockServiceModes["google-oauth"] = "managed";
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "[]",
    });
    await expect(
      getRoute("POST", "oauth/disconnect").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("managed mode with multiple connections demands disambiguation", async () => {
    mockServiceModes["google-oauth"] = "managed";
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: "conn-a", account_label: "a@example.com" },
        { id: "conn-b", account_label: "b@example.com" },
      ],
      text: async () => "",
    });
    await expect(
      getRoute("POST", "oauth/disconnect").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// GET oauth/mode
// ---------------------------------------------------------------------------

describe("GET oauth/mode", () => {
  test("rejects missing provider", () => {
    // handleModeGet is synchronous — use toThrow rather than rejects.
    expect(() =>
      getRoute("GET", "oauth/mode").handler(makeArgs({ queryParams: {} })),
    ).toThrow(BadRequestError);
  });

  test("returns managed-supported provider mode", async () => {
    mockServiceModes["google-oauth"] = "managed";
    const result = (await getRoute("GET", "oauth/mode").handler(
      makeArgs({ queryParams: { provider: "google" } }),
    )) as { mode: string; managedModeSupported: boolean };
    expect(result.mode).toBe("managed");
    expect(result.managedModeSupported).toBe(true);
  });

  test("BYO-only provider returns your-own with managedModeSupported=false", async () => {
    mockProviders.byo = {
      ...baseProvider,
      provider: "byo",
      managedServiceConfigKey: null,
    };
    const result = (await getRoute("GET", "oauth/mode").handler(
      makeArgs({ queryParams: { provider: "byo" } }),
    )) as { mode: string; managedModeSupported: boolean };
    expect(result.mode).toBe("your-own");
    expect(result.managedModeSupported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST oauth/mode
// ---------------------------------------------------------------------------

describe("POST oauth/mode", () => {
  test("rejects invalid mode value", async () => {
    await expect(
      getRoute("POST", "oauth/mode").handler(
        makeArgs({ body: { provider: "google", mode: "bogus" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects switching to managed on BYO-only provider", async () => {
    mockProviders.byo = {
      ...baseProvider,
      provider: "byo",
      managedServiceConfigKey: null,
    };
    await expect(
      getRoute("POST", "oauth/mode").handler(
        makeArgs({ body: { provider: "byo", mode: "managed" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("switching to your-own on BYO-only provider is a no-op success", async () => {
    mockProviders.byo = {
      ...baseProvider,
      provider: "byo",
      managedServiceConfigKey: null,
    };
    const result = (await getRoute("POST", "oauth/mode").handler(
      makeArgs({ body: { provider: "byo", mode: "your-own" } }),
    )) as { changed: boolean };
    expect(result.changed).toBe(false);
    expect(mockSaveRawConfig).not.toHaveBeenCalled();
  });

  test("requires platform connection when switching to managed", async () => {
    platformAvailable = false;
    await expect(
      getRoute("POST", "oauth/mode").handler(
        makeArgs({ body: { provider: "google", mode: "managed" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("persists mode change when current differs from new", async () => {
    mockServiceModes["google-oauth"] = "your-own";
    const result = (await getRoute("POST", "oauth/mode").handler(
      makeArgs({ body: { provider: "google", mode: "managed" } }),
    )) as { changed: boolean };
    expect(result.changed).toBe(true);
    expect(mockSaveRawConfig).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET oauth/status
// ---------------------------------------------------------------------------

describe("GET oauth/status", () => {
  test("rejects missing provider", async () => {
    await expect(
      getRoute("GET", "oauth/status").handler(makeArgs({ queryParams: {} })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("BYO mode surfaces active connections with parsed scopes", async () => {
    mockAllConnections.google = [
      {
        id: "conn-1",
        accountInfo: "alice@example.com",
        grantedScopes: '["email","profile"]',
        status: "active",
        hasRefreshToken: 1,
        expiresAt: 1735689600000,
      },
      {
        // Inactive row should be filtered out
        id: "conn-2",
        accountInfo: null,
        grantedScopes: null,
        status: "revoked",
        hasRefreshToken: 0,
        expiresAt: null,
      },
    ];
    const result = (await getRoute("GET", "oauth/status").handler(
      makeArgs({ queryParams: { provider: "google" } }),
    )) as {
      mode: string;
      connections: Array<{ id: string; grantedScopes: string[] }>;
    };
    expect(result.mode).toBe("byo");
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]!.id).toBe("conn-1");
    expect(result.connections[0]!.grantedScopes).toEqual(["email", "profile"]);
  });

  test("malformed grantedScopes JSON defaults to empty", async () => {
    mockAllConnections.google = [
      {
        id: "conn-bad",
        accountInfo: null,
        grantedScopes: "not-json",
        status: "active",
        hasRefreshToken: 0,
        expiresAt: null,
      },
    ];
    const result = (await getRoute("GET", "oauth/status").handler(
      makeArgs({ queryParams: { provider: "google" } }),
    )) as { connections: Array<{ grantedScopes: string[] }> };
    expect(result.connections[0]!.grantedScopes).toEqual([]);
  });

  test("BYO mode reconciles manual-token providers before listing status", async () => {
    mockProviders.telegram = {
      ...baseProvider,
      provider: "telegram",
      authorizeUrl: "urn:manual-token",
      managedServiceConfigKey: null,
      baseUrl: "https://api.telegram.org",
    };
    mockAllConnections.telegram = [
      {
        id: "conn-telegram",
        accountInfo: "@example_bot",
        grantedScopes: "[]",
        status: "active",
        hasRefreshToken: 0,
        expiresAt: null,
      },
    ];

    const result = (await getRoute("GET", "oauth/status").handler(
      makeArgs({ queryParams: { provider: "telegram" } }),
    )) as { connections: Array<{ account: string | null }> };

    expect(mockSyncManualTokenCalls).toEqual(["telegram"]);
    expect(result.connections[0]!.account).toBe("@example_bot");
  });

  test("managed mode surfaces platform connections", async () => {
    mockServiceModes["google-oauth"] = "managed";
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "conn-platform",
          account_label: "alice@example.com",
          scopes_granted: ["email"],
          status: "ACTIVE",
        },
      ],
      text: async () => "",
    });
    const result = (await getRoute("GET", "oauth/status").handler(
      makeArgs({ queryParams: { provider: "google" } }),
    )) as { mode: string; connections: Array<{ id: string }> };
    expect(result.mode).toBe("managed");
    expect(result.connections[0]!.id).toBe("conn-platform");
  });
});

// ---------------------------------------------------------------------------
// POST oauth/ping
// ---------------------------------------------------------------------------

describe("POST oauth/ping", () => {
  test("rejects provider without configured pingUrl", async () => {
    await expect(
      getRoute("POST", "oauth/ping").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("returns ok=true for 2xx response", async () => {
    mockProviders.google = {
      ...baseProvider,
      pingUrl: "https://api.google.com/v1/me",
    };
    mockResolveResponse = { status: 200, headers: {}, body: { ok: true } };
    const result = (await getRoute("POST", "oauth/ping").handler(
      makeArgs({ body: { provider: "google" } }),
    )) as { ok: boolean; provider: string; status: number };
    expect(result).toEqual({ ok: true, provider: "google", status: 200 });
  });

  test("returns ok=false with reconnect hint on 401", async () => {
    mockProviders.google = {
      ...baseProvider,
      pingUrl: "https://api.google.com/v1/me",
    };
    mockResolveResponse = {
      status: 401,
      headers: {},
      body: { error: "unauthorized" },
    };
    const result = (await getRoute("POST", "oauth/ping").handler(
      makeArgs({ body: { provider: "google" } }),
    )) as { ok: boolean; status: number; hint?: string };
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.hint).toContain("oauth connect");
  });
});

// ---------------------------------------------------------------------------
// POST oauth/token
// ---------------------------------------------------------------------------

describe("POST oauth/token", () => {
  test("rejects managed-mode providers", async () => {
    mockServiceModes["google-oauth"] = "managed";
    await expect(
      getRoute("POST", "oauth/token").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("returns token from withValidToken in BYO mode", async () => {
    mockTokenValue = "tok-real";
    const result = (await getRoute("POST", "oauth/token").handler(
      makeArgs({ body: { provider: "google" } }),
    )) as { ok: boolean; token: string };
    expect(result).toEqual({ ok: true, token: "tok-real" });
  });

  test("rejects when account is given but no matching connection", async () => {
    // No active connections registered for google
    await expect(
      getRoute("POST", "oauth/token").handler(
        makeArgs({
          body: { provider: "google", account: "missing@example.com" },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// POST oauth/request
// ---------------------------------------------------------------------------

describe("POST oauth/request", () => {
  test("rejects missing url", async () => {
    await expect(
      getRoute("POST", "oauth/request").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("happy-path GET returns response payload", async () => {
    mockResolveResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
    };
    const result = (await getRoute("POST", "oauth/request").handler(
      makeArgs({
        body: { provider: "google", url: "https://api.google.com/v1/me" },
      }),
    )) as { ok: boolean; status: number; body: unknown };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hello: "world" });
  });

  test("rejects absolute URL host outside provider base host when no injection templates exist", async () => {
    await expect(
      getRoute("POST", "oauth/request").handler(
        makeArgs({
          body: { provider: "google", url: "https://attacker.example/v1/me" },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockResolveRequests).toHaveLength(0);
  });

  test("rejects protocol downgrade for absolute OAuth request URLs", async () => {
    await expect(
      getRoute("POST", "oauth/request").handler(
        makeArgs({
          body: { provider: "google", url: "http://api.google.com/v1/me" },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockResolveRequests).toHaveLength(0);
  });

  test("rejects absolute URL host outside provider injection templates", async () => {
    mockProviders.slack_channel = {
      ...baseProvider,
      provider: "slack_channel",
      managedServiceConfigKey: null,
      baseUrl: "https://slack.com/api",
      injectionTemplates: JSON.stringify([
        {
          hostPattern: "slack.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ]),
    };

    await expect(
      getRoute("POST", "oauth/request").handler(
        makeArgs({
          body: {
            provider: "slack_channel",
            url: "https://attacker.example/api/auth.test",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockResolveRequests).toHaveLength(0);
  });

  test("allows absolute URL host matching provider injection templates", async () => {
    mockProviders.slack_channel = {
      ...baseProvider,
      provider: "slack_channel",
      managedServiceConfigKey: null,
      baseUrl: "https://slack.com/api",
      injectionTemplates: JSON.stringify([
        {
          hostPattern: "slack.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ]),
    };

    await getRoute("POST", "oauth/request").handler(
      makeArgs({
        body: {
          provider: "slack_channel",
          url: "https://slack.com/api/auth.test?team=T123",
        },
      }),
    );

    expect(mockResolveRequests).toEqual([
      {
        method: "GET",
        path: "/api/auth.test",
        query: { team: "T123" },
        baseUrl: "https://slack.com",
      },
    ]);
  });

  test("allows cross-host absolute URLs declared by provider injection templates", async () => {
    mockProviders.google = {
      ...baseProvider,
      baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
      injectionTemplates: JSON.stringify([
        {
          hostPattern: "gmail.googleapis.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
        {
          hostPattern: "www.googleapis.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ]),
    };

    await getRoute("POST", "oauth/request").handler(
      makeArgs({
        body: {
          provider: "google",
          url: "https://www.googleapis.com/calendar/v3/calendars",
        },
      }),
    );

    expect(mockResolveRequests).toEqual([
      {
        method: "GET",
        path: "/calendar/v3/calendars",
        baseUrl: "https://www.googleapis.com",
      },
    ]);
  });

  test("attaches reconnect hint on 401 response", async () => {
    mockResolveResponse = { status: 401, headers: {}, body: { error: "no" } };
    const result = (await getRoute("POST", "oauth/request").handler(
      makeArgs({
        body: { provider: "google", url: "https://api.google.com/v1/me" },
      }),
    )) as { ok: boolean; hint?: string };
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("oauth status");
  });

  test("rejects unregistered client_id in BYO mode", async () => {
    // No entry in mockApps for google:client-x
    await expect(
      getRoute("POST", "oauth/request").handler(
        makeArgs({
          body: {
            provider: "google",
            url: "https://api.google.com/v1/me",
            client_id: "client-x",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// POST oauth/managed-connect/start
// ---------------------------------------------------------------------------

describe("POST oauth/managed-connect/start", () => {
  test("returns connect_url on platform 200", async () => {
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ connect_url: "https://app.vellum.ai/connect/abc" }),
      text: async () => "",
    });
    const result = (await getRoute(
      "POST",
      "oauth/managed-connect/start",
    ).handler(
      makeArgs({ body: { provider: "google", scopes: ["email"] } }),
    )) as { ok: boolean; connect_url: string };
    expect(result.connect_url).toBe("https://app.vellum.ai/connect/abc");
  });

  test("raises InternalError when platform returns 401", async () => {
    mockFetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "unauthorized",
    });
    await expect(
      getRoute("POST", "oauth/managed-connect/start").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });

  test("raises InternalError when platform omits connect_url", async () => {
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    });
    await expect(
      getRoute("POST", "oauth/managed-connect/start").handler(
        makeArgs({ body: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });
});

// ---------------------------------------------------------------------------
// GET oauth/managed-connect/poll
// ---------------------------------------------------------------------------

describe("GET oauth/managed-connect/poll", () => {
  test("rejects missing provider", async () => {
    await expect(
      getRoute("GET", "oauth/managed-connect/poll").handler(
        makeArgs({ queryParams: {} }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("returns platform connections list", async () => {
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "conn-1",
          account_label: "alice@example.com",
          scopes_granted: ["email"],
        },
      ],
      text: async () => "",
    });
    const result = (await getRoute("GET", "oauth/managed-connect/poll").handler(
      makeArgs({ queryParams: { provider: "google" } }),
    )) as {
      ok: boolean;
      connections: Array<{
        id: string;
        account_label: string | null;
        scopes_granted: string[];
      }>;
    };
    expect(result.ok).toBe(true);
    expect(result.connections).toEqual([
      {
        id: "conn-1",
        account_label: "alice@example.com",
        scopes_granted: ["email"],
      },
    ]);
  });

  test("raises BadRequestError when platform unavailable", async () => {
    platformAvailable = false;
    await expect(
      getRoute("GET", "oauth/managed-connect/poll").handler(
        makeArgs({ queryParams: { provider: "google" } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
