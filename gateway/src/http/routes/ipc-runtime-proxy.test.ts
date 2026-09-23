/**
 * Tests for the IPC runtime proxy.
 *
 * Uses mock.module to stub the IPC client and route schema cache, and
 * exercises the proxy handler under different scenarios: auth, path
 * matching, header filtering, error propagation.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import "../../__tests__/test-preload.js";

import { isTrustCheckedScopeProfile } from "@vellumai/gateway-client";

import { isNarrowScopeProfile } from "../../auth/scopes.js";
import type { ScopeProfile } from "../../auth/types.js";

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
  // A policy that names principals but no scope. `enforcePolicy` treats it
  // exactly like `policy: null`, so the IPC fast path must too.
  {
    operationId: "debug_ping",
    endpoint: "debug/ping",
    method: "GET",
    policy: {
      requiredScopes: [],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    },
  },
  // A guardian-only route as a current daemon ships it, with the trust class
  // resolved onto the wire.
  {
    operationId: "messages_post",
    endpoint: "messages",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
      allowedTrustClasses: ["guardian"],
    },
  },
  // A route that admits contacts and not the guardian.
  {
    operationId: "contact_only_probe",
    endpoint: "contact-only-probe",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor"],
      allowedTrustClasses: ["trusted_contact"],
    },
  },
  // A parameterized route that admits contacts and not the guardian.
  {
    operationId: "contact_only_item",
    endpoint: "contact-only/:id",
    method: "GET",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor"],
      allowedTrustClasses: ["trusted_contact"],
    },
  },
  // A route that opts into contacts.
  {
    operationId: "contact_probe",
    endpoint: "contact-probe",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor"],
      allowedTrustClasses: [
        "guardian",
        "trusted_contact",
        "unverified_contact",
      ],
    },
  },
  // The OAuth passthrough proxy: the one route an oauth_proxy_v1 grant opens.
  {
    operationId: "oauth_proxy_get",
    endpoint: "oauth/proxy/:provider/:path*",
    method: "GET",
    policy: {
      requiredScopes: ["oauth.proxy"],
      allowedPrincipalTypes: ["local"],
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

// Stub validateEdgeToken; by default auth passes. The rest of the module keeps
// its real implementation.
const actualTokenExchange = await import("../../auth/token-exchange.js");

const validateEdgeTokenMock = mock(
  (
    _token: string,
  ):
    | { ok: true; claims: Record<string, string | number> }
    | { ok: false; reason: string } => ({
    ok: true,
    claims: { sub: "actor:asst_1:user_1", scope_profile: "actor_client_v1" },
  }),
);

mock.module("../../auth/token-exchange.js", () => ({
  ...actualTokenExchange,
  validateEdgeToken: validateEdgeTokenMock,
}));

// Stub the HTTP transport so the fall-through path can be observed without a
// real upstream. Reassigned per test; the module indirection is what makes
// interception reliable on every platform (see `src/fetch.ts`).
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// The contact trust lookup reads the gateway ACL; stubbed per test.
type Verdict = { trustClass: string; resolutionFailed?: boolean };
const resolveTrustVerdictMock = mock(
  async (_input: {
    channelType: string;
    actorExternalId?: string;
  }): Promise<Verdict> => ({ trustClass: "trusted_contact" }),
);
const actualTrustVerdictResolver =
  await import("../../risk/trust-verdict-resolver.js");
mock.module("../../risk/trust-verdict-resolver.js", () => ({
  ...actualTrustVerdictResolver,
  resolveTrustVerdict: resolveTrustVerdictMock,
}));

// The HTTP proxy mints a service token for the daemon on every request.
const { initSigningKey } = await import("../../auth/token-service.js");
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

// ---------------------------------------------------------------------------
// Import modules under test (after all mocks are registered)
// ---------------------------------------------------------------------------

const { matchRoute, refreshRouteSchema } =
  await import("../../ipc/route-schema-cache.js");

// Prime the route schema cache with test routes
await refreshRouteSchema();

const { tryIpcProxy } = await import("./ipc-runtime-proxy.js");
const { createRuntimeProxyHandler } = await import("./runtime-proxy.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: { runtimeProxyRequireAuth?: boolean }) {
  return {
    runtimeProxyRequireAuth: false,
    // Read only by the HTTP proxy, which a couple of tests drive end to end.
    assistantRuntimeBaseUrl: "http://localhost:7821",
    runtimeTimeoutMs: 30_000,
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
    expect(matchRoute("GET", "health")).toEqual({
      operationId: "health",
      pathParams: {},
    });
  });

  test("matches parameterized endpoint and extracts params", () => {
    expect(matchRoute("POST", "acp/abc123/steer")).toEqual({
      operationId: "acp_steer",
      pathParams: { id: "abc123" },
    });
  });

  test("matches multi-param endpoint", () => {
    expect(matchRoute("GET", "apps/myapp/dist/bundle.js")).toEqual({
      operationId: "apps_dist_file",
      pathParams: { appId: "myapp", filename: "bundle.js" },
    });
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
    expect(matchRoute("POST", "acp/hello%20world/steer")).toEqual({
      operationId: "acp_steer",
      pathParams: { id: "hello world" },
    });
  });

  test("reports a matched route whose param cannot be decoded", () => {
    expect(matchRoute("POST", "acp/a%zz/steer")).toEqual({
      malformedPath: true,
      operationId: "acp_steer",
    });
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
      claims: { sub: "actor:asst_1:user_1", scope_profile: "actor_client_v1" },
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

  test("returns 400 for malformed percent-encoding in the path", async () => {
    // The passthrough forwards caller-authored paths, so an undecodable one
    // is a typo away. It must not surface as an unhandled 500.
    const req = makeRequest("/v1/oauth/proxy/gh/a%zz");
    const result = await tryIpcProxy(req, makeConfig());
    expect(result!.status).toBe(400);

    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("the malformed path does not escape the proxy handler as a 500", async () => {
    const handler = createRuntimeProxyHandler(makeConfig());
    const response = await handler(makeRequest("/v1/oauth/proxy/gh/a%zz"));
    expect(response.status).toBe(400);
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

  test("leaves a JSON body readable so the HTTP proxy can forward it", async () => {
    // The IPC attempt parses the body to build its params. Consuming the
    // caller's own request would make the retry-over-HTTP path throw
    // "Body already used" and turn every non-GET fallback into a 500.
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

    let forwarded: { url: string; method: string; body: string } | undefined;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        forwarded = {
          url: String(input),
          method: init?.method ?? "GET",
          body: new TextDecoder().decode(init?.body as ArrayBuffer),
        };
        return new Response("forwarded", { status: 200 });
      },
    );

    const payload = JSON.stringify({ message: "hello" });
    const handler = createRuntimeProxyHandler(makeConfig());
    const response = await handler(
      makeRequest("/v1/acp/test-id/steer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("forwarded");
    expect(forwarded).toEqual({
      url: "http://localhost:7821/v1/acp/test-id/steer",
      method: "POST",
      body: payload,
    });
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

  test("strips a spoofed x-vellum-subject from an authenticated request", async () => {
    // Nothing downstream consumes the header: the daemon's IPC adapter
    // (`injectLocalActorHeader`) deletes it on every dispatch.
    validateEdgeTokenMock.mockImplementation(() => ({
      ok: true,
      claims: {
        iss: "vellum-auth",
        aud: "vellum-gateway",
        sub: "local:asst_1:oauth-proxy.stripe_link",
        scope_profile: "oauth_proxy_v1",
        exp: Math.floor(Date.now() / 1000) + 3600,
        policy_epoch: 1,
      },
    }));

    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/oauth/proxy/stripe_link/v1/accounts", {
      headers: {
        authorization: "Bearer valid",
        "x-vellum-subject": "local:self:oauth-proxy.attacker",
      },
    });
    await tryIpcProxy(req, config);

    const [, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const headers = params.headers as Record<string, string>;
    expect(headers["x-vellum-subject"]).toBeUndefined();
  });

  test("derives the principal headers from the verified claims", async () => {
    const config = makeConfig({ runtimeProxyRequireAuth: true });
    const req = makeRequest("/v1/health", {
      headers: {
        authorization: "Bearer valid",
        "x-vellum-actor-principal-id": "attacker",
        "x-vellum-principal-type": "svc_gateway",
      },
    });
    await tryIpcProxy(req, config);

    const [, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const headers = params.headers as Record<string, string>;
    expect(headers["x-vellum-principal-type"]).toBe("actor");
    expect(headers["x-vellum-actor-principal-id"]).toBe("user_1");
  });

  test("strips x-vellum-subject when the request is unauthenticated", async () => {
    const req = makeRequest("/v1/health", {
      headers: { "x-vellum-subject": "local:self:oauth-proxy.attacker" },
    });
    await tryIpcProxy(req, makeConfig());

    const [, params] = ipcCallAssistantMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const headers = params.headers as Record<string, string>;
    expect(headers["x-vellum-subject"]).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Tests: single-route grants on the IPC fast path
//
// An oauth_proxy_v1 grant is printed for a user to export into a stock
// third-party CLI's environment. Setting one request header engages this fast
// path, and the daemon's IPC server runs no policy check behind it, so the
// containment has to hold here.
// ---------------------------------------------------------------------------

/** Subject shapes that parse for each profile under test. */
const SUB_BY_PROFILE: Record<ScopeProfile, string> = {
  actor_client_v1: "actor:asst_1:user_1",
  contact_client_v1: "actor:asst_1:contact_1",
  gateway_ingress_v1: "svc:gateway:self",
  gateway_service_v1: "svc:gateway:self",
  local_v1: "local:asst_1:conv_1",
  oauth_proxy_v1: "local:asst_1:oauth-proxy.stripe_link",
  speech_relay_v1: "svc:daemon:self",
  ui_page_v1: "svc:gateway:self",
};

/**
 * Every profile, paired with the status it gets on a route that names no
 * scope. The classification is the source's own (`isNarrowScopeProfile`);
 * these cases assert the fast path consults it. A contact token is refused
 * earlier, by the route's trust class, with a 404 (see
 * `isTrustCheckedScopeProfile`). `SUB_BY_PROFILE` is exhaustive over
 * ScopeProfile, so a new profile joins the sweep by declaring its subject.
 */
const UNSCOPED_ROUTE_STATUS = (
  Object.keys(SUB_BY_PROFILE) as ScopeProfile[]
).map((profile) => {
  if (isTrustCheckedScopeProfile(profile)) {
    return [profile, 404] as const;
  }
  return [profile, isNarrowScopeProfile(profile) ? 403 : 200] as const;
});

function mockClaims(profile: ScopeProfile) {
  validateEdgeTokenMock.mockImplementation(() => ({
    ok: true,
    claims: {
      iss: "vellum-auth",
      aud: "vellum-gateway",
      sub: SUB_BY_PROFILE[profile],
      scope_profile: profile,
      exp: Math.floor(Date.now() / 1000) + 3600,
      policy_epoch: 1,
    },
  }));
}

const AUTHED_CONFIG = () => makeConfig({ runtimeProxyRequireAuth: true });

describe("single-route grants on the IPC fast path", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockReset();
    ipcCallAssistantMock.mockImplementation(defaultIpcImpl);
    validateEdgeTokenMock.mockReset();
  });

  test.each(UNSCOPED_ROUTE_STATUS)(
    "%s on a null-policy route",
    async (profile, status) => {
      mockClaims(profile);
      const req = makeRequest("/v1/health", {
        headers: { authorization: "Bearer valid" },
      });
      const result = await tryIpcProxy(req, AUTHED_CONFIG());
      expect(result!.status).toBe(status);
    },
  );

  test.each(UNSCOPED_ROUTE_STATUS)(
    "%s on a route whose policy names no scope",
    async (profile, status) => {
      mockClaims(profile);
      const req = makeRequest("/v1/debug/ping", {
        headers: { authorization: "Bearer valid" },
      });
      const result = await tryIpcProxy(req, AUTHED_CONFIG());
      expect(result!.status).toBe(status);
    },
  );

  test("a proxy grant reaches no route over IPC beyond the passthrough", async () => {
    mockClaims("oauth_proxy_v1");
    const req = makeRequest("/v1/health", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());

    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    // Refused before the daemon is called: nothing downstream re-checks.
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("the passthrough proxy route still serves a proxy grant over IPC", async () => {
    mockClaims("oauth_proxy_v1");
    const req = makeRequest("/v1/oauth/proxy/stripe_link/v1/accounts", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());

    expect(result!.status).toBe(200);
    const [opId] = ipcCallAssistantMock.mock.calls[0] as [string];
    expect(opId).toBe("oauth_proxy_get");
  });

  test("the passthrough proxy route still falls back to HTTP for a binary reply", async () => {
    mockClaims("oauth_proxy_v1");
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

    const req = makeRequest("/v1/oauth/proxy/stripe_link/v1/accounts", {
      headers: { authorization: "Bearer valid" },
    });
    expect(await tryIpcProxy(req, AUTHED_CONFIG())).toBeNull();
  });

  test("a speech-relay token is refused on an unprotected route", async () => {
    mockClaims("speech_relay_v1");
    const req = makeRequest("/v1/health", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());
    expect(result!.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: trust class on the IPC fast path
//
// The daemon's IPC server runs no policy check, so this is the only place a
// contact token is kept off guardian routes for IPC-served requests.
// ---------------------------------------------------------------------------

function postJson(path: string): Request {
  return makeRequest(path, {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

describe("trust class on the IPC fast path", () => {
  beforeEach(() => {
    ipcCallAssistantMock.mockReset();
    ipcCallAssistantMock.mockImplementation(defaultIpcImpl);
    validateEdgeTokenMock.mockReset();
    resolveTrustVerdictMock.mockReset();
    resolveTrustVerdictMock.mockImplementation(async () => ({
      trustClass: "trusted_contact",
    }));
  });

  test("a contact token gets 404 from POST /v1/messages", async () => {
    mockClaims("contact_client_v1");
    const result = await tryIpcProxy(postJson("/v1/messages"), AUTHED_CONFIG());

    expect(result!.status).toBe(404);
    expect(await result!.json()).toEqual({
      error: "Not found",
      source: "ipc-proxy",
    });
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("a contact token gets 404 from every route not admitting contacts", async () => {
    mockClaims("contact_client_v1");
    const refused = ROUTE_SCHEMA.filter(
      (route) =>
        !route.policy?.allowedTrustClasses?.includes("trusted_contact"),
    );
    const leaks: string[] = [];
    for (const route of refused) {
      const path = route.endpoint.replace(/:[^/]+\*?/g, "x");
      const req = makeRequest(`/v1/${path}`, {
        method: route.method,
        headers: { authorization: "Bearer valid" },
      });
      const result = await tryIpcProxy(req, AUTHED_CONFIG());
      if (result?.status !== 404) {
        leaks.push(`${route.method} ${route.endpoint}: ${result?.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("a contact token gets 404, not 400, for a malformed path", async () => {
    mockClaims("contact_client_v1");
    const req = makeRequest("/v1/oauth/proxy/gh/a%zz", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());

    expect(result!.status).toBe(404);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("a guardian token reaches a route admitting guardians and contacts", async () => {
    mockClaims("actor_client_v1");
    const result = await tryIpcProxy(
      postJson("/v1/contact-probe"),
      AUTHED_CONFIG(),
    );

    expect(result!.status).toBe(200);
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("a guardian token gets 404 from a contact-only route, without a lookup", async () => {
    mockClaims("actor_client_v1");
    const result = await tryIpcProxy(
      postJson("/v1/contact-only-probe"),
      AUTHED_CONFIG(),
    );

    expect(result!.status).toBe(404);
    expect(await result!.json()).toEqual({
      error: "Not found",
      source: "ipc-proxy",
    });
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("a contact token reaches a contact-only route", async () => {
    mockClaims("contact_client_v1");
    const result = await tryIpcProxy(
      postJson("/v1/contact-only-probe"),
      AUTHED_CONFIG(),
    );

    expect(result!.status).toBe(200);
    const [opId] = ipcCallAssistantMock.mock.calls[0] as [string];
    expect(opId).toBe("contact_only_probe");
  });

  test("with auth disabled, a contact-only route is a 404 and others proxy", async () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });

    const refused = await tryIpcProxy(
      postJson("/v1/contact-only-probe"),
      config,
    );
    expect(refused!.status).toBe(404);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();

    const served = await tryIpcProxy(postJson("/v1/messages"), config);
    expect(served!.status).toBe(200);
    const [opId] = ipcCallAssistantMock.mock.calls[0] as [string];
    expect(opId).toBe("messages_post");
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("a guardian gets 404, not 400, for a malformed path on a contact-only route", async () => {
    mockClaims("actor_client_v1");
    const req = makeRequest("/v1/contact-only/a%zz", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());

    expect(result!.status).toBe(404);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test("with auth disabled, a malformed path on a contact-only route is a 404", async () => {
    const req = makeRequest("/v1/contact-only/a%zz");
    const result = await tryIpcProxy(
      req,
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    expect(result!.status).toBe(404);
  });

  test("a guardian still gets 400 for a malformed path on a default route", async () => {
    mockClaims("actor_client_v1");
    const req = makeRequest("/v1/oauth/proxy/gh/a%zz", {
      headers: { authorization: "Bearer valid" },
    });
    const result = await tryIpcProxy(req, AUTHED_CONFIG());

    expect(result!.status).toBe(400);
    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("a guardian token is unaffected and never looked up", async () => {
    mockClaims("actor_client_v1");
    const result = await tryIpcProxy(postJson("/v1/messages"), AUTHED_CONFIG());

    expect(result!.status).toBe(200);
    expect(ipcCallAssistantMock).toHaveBeenCalledTimes(1);
    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
  });

  test.each(["trusted_contact", "unverified_contact"])(
    "a route admitting contacts serves a %s, resolved on vellum-shared",
    async (trustClass) => {
      mockClaims("contact_client_v1");
      resolveTrustVerdictMock.mockImplementation(async () => ({ trustClass }));
      const result = await tryIpcProxy(
        postJson("/v1/contact-probe"),
        AUTHED_CONFIG(),
      );

      expect(result!.status).toBe(200);
      expect(resolveTrustVerdictMock).toHaveBeenCalledWith({
        channelType: "vellum-shared",
        actorExternalId: "contact_1",
      });
      const [opId] = ipcCallAssistantMock.mock.calls[0] as [string];
      expect(opId).toBe("contact_probe");
    },
  );

  test.each([
    ["an unknown principal", { trustClass: "unknown" }],
    ["a principal resolving guardian", { trustClass: "guardian" }],
    [
      "a verdict the resolver could not vouch for",
      { trustClass: "trusted_contact", resolutionFailed: true },
    ],
  ] as const)(
    "a route admitting contacts refuses %s",
    async (_label, verdict) => {
      mockClaims("contact_client_v1");
      resolveTrustVerdictMock.mockImplementation(async () => verdict);
      const result = await tryIpcProxy(
        postJson("/v1/contact-probe"),
        AUTHED_CONFIG(),
      );

      expect(result!.status).toBe(404);
      expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    },
  );

  test("a failed trust lookup refuses", async () => {
    mockClaims("contact_client_v1");
    resolveTrustVerdictMock.mockImplementation(async () => {
      throw new Error("db unavailable");
    });
    const result = await tryIpcProxy(
      postJson("/v1/contact-probe"),
      AUTHED_CONFIG(),
    );

    expect(result!.status).toBe(404);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("a schema without allowedTrustClasses still proxies, guardian only", async () => {
    // `settings_get` carries no trust classes, as a daemon predating the
    // field serves it.
    mockClaims("actor_client_v1");
    const guardian = await tryIpcProxy(
      makeRequest("/v1/settings", {
        headers: { authorization: "Bearer valid" },
      }),
      AUTHED_CONFIG(),
    );
    expect(guardian!.status).toBe(200);

    mockClaims("contact_client_v1");
    const contact = await tryIpcProxy(
      makeRequest("/v1/settings", {
        headers: { authorization: "Bearer valid" },
      }),
      AUTHED_CONFIG(),
    );
    expect(contact!.status).toBe(404);
  });
});
