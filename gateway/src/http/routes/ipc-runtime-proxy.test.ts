/**
 * Tests for the IPC runtime proxy.
 *
 * Uses mock.module to stub the IPC client and route schema cache, and
 * exercises the proxy handler under different scenarios: auth, path
 * matching, header filtering, error propagation.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import "../../__tests__/test-preload.js";

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

// Spread the actual module so the real IpcHandlerError/IpcTransportError
// classes (thrown by tests below, caught via instanceof in the proxy) and
// untouched exports like ipcSuggestTrustRule stay importable by later-loaded
// files when suites share a bun process.
const actualAssistantClient = await import("../../ipc/assistant-client.js");
const { IpcHandlerError, IpcTransportError } = actualAssistantClient;

// Single mock for `ipcCallAssistant` — used by both `refreshRouteSchema`
// (to prime the cache) and `tryIpcProxy` (per-request IPC calls).
//
// Every entry carries an explicit `policy: { ... } | null` field — that's
// the wire shape the daemon's IPC route adapter ships and the schema
// cache validates against (Zod-enforced; missing `policy` would fail to
// load, denying IPC proxying for that schema).
const ROUTE_SCHEMA = [
  // Routes the daemon explicitly registers as unprotected (health/debug)
  // come through with `policy: null`.
  { operationId: "health", endpoint: "health", method: "GET", policy: null },
  {
    operationId: "acp_steer",
    endpoint: "acp/:id/steer",
    method: "POST",
    policy: null,
  },
  {
    operationId: "acp_list_sessions",
    endpoint: "acp/sessions",
    method: "GET",
    policy: null,
  },
  {
    operationId: "apps_dist_file",
    endpoint: "apps/:appId/dist/:filename",
    method: "GET",
    policy: null,
  },
  // Policy-enforced routes: the daemon resolved scopes + principals and
  // ships them in the schema, eliminating the parallel gateway table.
  {
    operationId: "settings_get",
    endpoint: "settings",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ["actor", "svc_gateway"],
    },
  },
  {
    operationId: "calls_start",
    endpoint: "calls/start",
    method: "POST",
    policy: {
      requiredScopes: ["calls.write"],
      allowedPrincipalTypes: ["actor"],
    },
  },
];

const defaultIpcImpl = (
  method: string,
  _params?: Record<string, unknown>,
): Promise<unknown> => {
  if (method === "get_route_schema") return Promise.resolve(ROUTE_SCHEMA);
  return Promise.resolve({ ok: true });
};

const ipcCallAssistantMock = mock(defaultIpcImpl);

mock.module("../../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcCallAssistantMock,
}));

// Stub validateEdgeToken — default: auth passes
const validateEdgeTokenMock = mock(
  (
    _token: string,
  ):
    | { ok: true; claims: Record<string, string | number> }
    | { ok: false; reason: string } => ({
    ok: true,
    claims: { sub: "test", scope_profile: "test" },
  }),
);

mock.module("../../auth/token-exchange.js", () => ({
  validateEdgeToken: validateEdgeTokenMock,
}));

// ---------------------------------------------------------------------------
// Import modules under test (after all mocks are registered)
// ---------------------------------------------------------------------------

const { matchRoute, refreshRouteSchema } =
  await import("../../ipc/route-schema-cache.js");

// Prime the route schema cache with test routes
await refreshRouteSchema();

const { tryIpcProxy } = await import("./ipc-runtime-proxy.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: { runtimeProxyRequireAuth?: boolean }) {
  return {
    runtimeProxyRequireAuth: false,
    ...overrides,
  } as unknown as import("../../config.js").GatewayConfig;
}

function makeRequest(
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  const { method = "GET", headers = {}, body } = options ?? {};
  return new Request(`http://localhost:8080${path}`, {
    method,
    headers: {
      "x-vellum-proxy-server": "ipc",
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests: route matching (via matchRoute directly)
// ---------------------------------------------------------------------------

describe("matchRoute", () => {
  test("matches static endpoint", () => {
    const m = matchRoute("GET", "health");
    expect(m).toBeDefined();
    expect(m!.operationId).toBe("health");
    expect(m!.pathParams).toEqual({});
  });

  test("matches parameterized endpoint and extracts params", () => {
    const m = matchRoute("POST", "acp/abc123/steer");
    expect(m).toBeDefined();
    expect(m!.operationId).toBe("acp_steer");
    expect(m!.pathParams).toEqual({ id: "abc123" });
  });

  test("matches multi-param endpoint", () => {
    const m = matchRoute("GET", "apps/myapp/dist/bundle.js");
    expect(m).toBeDefined();
    expect(m!.operationId).toBe("apps_dist_file");
    expect(m!.pathParams).toEqual({ appId: "myapp", filename: "bundle.js" });
  });

  test("returns undefined for method mismatch", () => {
    expect(matchRoute("DELETE", "health")).toBeUndefined();
  });

  test("returns undefined for unknown path", () => {
    expect(matchRoute("GET", "nonexistent/path")).toBeUndefined();
  });

  test("does not match partial paths", () => {
    expect(matchRoute("GET", "health/extra")).toBeUndefined();
  });

  test("decodes percent-encoded path params", () => {
    const m = matchRoute("POST", "acp/hello%20world/steer");
    expect(m).toBeDefined();
    expect(m!.pathParams).toEqual({ id: "hello world" });
  });
});

// ---------------------------------------------------------------------------
// Tests: tryIpcProxy
// ---------------------------------------------------------------------------

describe("tryIpcProxy", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockReset();
    ipcCallAssistantMock.mockImplementation(defaultIpcImpl);
    validateEdgeTokenMock.mockReset();
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: { sub: "test", scope_profile: "test" },
    }));
  });

  test("returns null when X-Vellum-Proxy-Server header is missing", async () => {
    const req = new Request("http://localhost:8080/v1/health");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result).toBeNull();
  });

  test("returns 404 for non-/v1/ path", async () => {
    const req = makeRequest("/other/path");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  test("returns 404 for unmatched route", async () => {
    const req = makeRequest("/v1/nonexistent/path");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  test("calls IPC with correct operationId and params", async () => {
    const req = makeRequest("/v1/acp/test-id/steer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vellum-conversation-id": "conv-123",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    const result = await tryIpcProxy(req, makeConfig());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);

    expect(ipcCallAssistantMock).toHaveBeenCalledTimes(1);
    const [opId, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(opId).toBe("acp_steer");
    expect(params.pathParams).toEqual({ id: "test-id" });
    expect(params.body).toEqual({ message: "hello" });
  });

  test("falls back to HTTP (returns null) on BINARY_UNSUPPORTED_OVER_IPC", async () => {
    // Binary/streaming routes can't be carried over the IPC transport. The
    // daemon signals this with a structured error; the proxy must return null
    // so the request falls through to the HTTP proxy rather than surfacing the
    // error to the client.
    ipcCallAssistantMock.mockImplementation((method: string) => {
      if (method === "get_route_schema") return Promise.resolve(ROUTE_SCHEMA);
      return Promise.reject(
        new IpcHandlerError(
          "Binary/streaming responses are not supported over the IPC transport; use HTTP",
          421,
          "BINARY_UNSUPPORTED_OVER_IPC",
        ),
      );
    });

    const req = makeRequest("/v1/apps/myapp/dist/bundle.js");
    const result = await tryIpcProxy(req, makeConfig());

    expect(result).toBeNull();
  });

  test("only forwards X-Vellum-* headers", async () => {
    const req = makeRequest("/v1/health", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        "x-vellum-conversation-id": "conv-123",
        "x-vellum-client-id": "client-456",
      },
    });

    await tryIpcProxy(req, makeConfig());

    const [, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const headers = params.headers as Record<string, string>;
    expect(headers["x-vellum-conversation-id"]).toBe("conv-123");
    expect(headers["x-vellum-client-id"]).toBe("client-456");
    expect(headers["x-vellum-proxy-server"]).toBe("ipc");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["cookie"]).toBeUndefined();
  });

  test("returns 401 when auth is required and no bearer token", async () => {
    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/health");
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(401);
  });

  test("returns 401 when auth is required and token is invalid", async () => {
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: false,
      reason: "expired",
    }));
    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/health", {
      headers: { authorization: "Bearer bad-token" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(401);
  });

  test("passes auth when token is valid", async () => {
    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/health", {
      headers: { authorization: "Bearer good-token" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(200);
    expect(validateEdgeTokenMock).toHaveBeenCalledWith("good-token");
  });

  test("returns handler error status code from IpcHandlerError", async () => {
    ipcCallAssistantMock.mockImplementation(() => {
      throw new IpcHandlerError("Not found", 404, "NOT_FOUND");
    });

    const req = makeRequest("/v1/health");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result!.status).toBe(404);

    const body = (await result!.json()) as Record<string, unknown>;
    expect(body.error).toBe("Not found");
    expect(body.code).toBe("NOT_FOUND");
  });

  test("returns 502 on transport error", async () => {
    ipcCallAssistantMock.mockImplementation(() => {
      throw new IpcTransportError("Socket closed");
    });

    const req = makeRequest("/v1/health");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result!.status).toBe(502);
  });

  test("passes query params to IPC", async () => {
    const req = makeRequest("/v1/acp/sessions?limit=10&offset=5");
    await tryIpcProxy(req, makeConfig());

    const [, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params.queryParams).toEqual({ limit: "10", offset: "5" });
  });
});

// ---------------------------------------------------------------------------
// Tests: policy enforcement
// ---------------------------------------------------------------------------

describe("policy enforcement", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockReset();
    ipcCallAssistantMock.mockImplementation(defaultIpcImpl);
    validateEdgeTokenMock.mockReset();
  });

  test("allows request when token has required scope", async () => {
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "actor:asst_1:user_1",
        scope_profile: "actor_client_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/settings", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(200);
  });

  test("returns 403 when token is missing required scope", async () => {
    // ui_page_v1 only has settings.read — not calls.write
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "actor:asst_1:user_1",
        scope_profile: "ui_page_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/calls/start", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("returns 403 when principal type is not allowed", async () => {
    // calls/start only allows "actor" — svc_daemon should be denied.
    // Use actor_client_v1 so it has the required calls.write scope;
    // the denial should come from the principal type check, not scope.
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "svc:daemon:asst_1",
        scope_profile: "actor_client_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/calls/start", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Principal type");
  });

  test("skips policy enforcement when auth is disabled", async () => {
    // Policy-enforced route, no auth required → should pass
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const req = makeRequest("/v1/settings");
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(200);
  });

  test("allows policy-enforced route when principal type matches", async () => {
    // settings allows both "actor" and "svc_gateway"
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "svc:gateway:asst_1",
        scope_profile: "gateway_service_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/settings", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(200);
  });

  test("no-policy routes are unaffected by auth context", async () => {
    // health has no policy — should always pass when authed
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "actor:asst_1:user_1",
        scope_profile: "ui_page_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/health", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(200);
  });

  test("returns 403 when sub claim is malformed", async () => {
    // A valid JWT with a garbage sub should be denied, not silently bypass
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "garbage",
        scope_profile: "actor_client_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/settings", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, config);
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Unable to determine principal type");
  });
});
