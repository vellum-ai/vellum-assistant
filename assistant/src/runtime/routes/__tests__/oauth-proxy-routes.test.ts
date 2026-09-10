/**
 * Wire-level tests for the OAuth passthrough proxy route.
 *
 * A stock third-party CLI drives this route, so the guarantees under test are
 * fidelity guarantees: the provider sees the path, query, headers, and bytes
 * the caller wrote, minus the daemon's own credential, and the caller sees the
 * provider's status, headers, and bytes back. Requests run through the real
 * HTTP adapter so the injected `x-vellum-*` headers and the raw-body path are
 * exercised rather than simulated.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "../../../oauth/connection.js";
import { decodeOAuthResponseBytes } from "../../../oauth/connection.js";
import {
  CredentialRequiredError,
  InsufficientBalanceError,
  PlatformOAuthConnection,
  ProviderUnreachableError,
} from "../../../oauth/platform-connection.js";
import type { VellumPlatformClient } from "../../../platform/client.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext } from "../../auth/types.js";
import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";
import type { RouteHandlerArgs } from "../types.js";

// ── Connection doubles ──────────────────────────────────────────────────────

let captured: OAuthConnectionRequest | undefined;
let upstream: OAuthConnectionResponse;
let upstreamBytes: Buffer | undefined;
let requestError: unknown;

async function serve(
  req: OAuthConnectionRequest,
): Promise<OAuthConnectionResponse> {
  captured = req;
  if (requestError) {
    throw requestError;
  }
  if (upstreamBytes) {
    // Same branch `BYOOAuthConnection.buildResponse` takes: raw bytes only
    // when the caller asked for them, otherwise the decoded value.
    return {
      ...upstream,
      body: req.rawResponseBody
        ? upstreamBytes
        : decodeOAuthResponseBytes(
            upstreamBytes,
            upstream.headers["content-type"] ?? "",
          ),
    };
  }
  return upstream;
}

const byoConnection: OAuthConnection = {
  id: "conn-byo",
  provider: "stripe_link",
  accountInfo: null,
  request: serve,
  async withToken() {
    throw new Error("the proxy never unwraps the raw token");
  },
};

/**
 * A real managed connection over a stub platform, for the paths whose behavior
 * lives inside `PlatformOAuthConnection` rather than in the route.
 */
function realManagedConnection(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): PlatformOAuthConnection {
  return new PlatformOAuthConnection({
    id: "conn-managed",
    provider: "stripe_link",
    externalId: "ext-1",
    accountInfo: null,
    connectionId: "platform-conn-1",
    client: {
      platformAssistantId: "asst-1",
      fetch: fetchImpl,
    } as unknown as VellumPlatformClient,
  });
}

/** Satisfies the route's `instanceof PlatformOAuthConnection` check. */
function managedConnection(): OAuthConnection {
  return Object.assign(
    Object.create(PlatformOAuthConnection.prototype) as OAuthConnection,
    {
      id: "conn-managed",
      provider: "stripe_link",
      accountInfo: null,
      request: serve,
    },
  );
}

// ── Module mocks ────────────────────────────────────────────────────────────

const providerLookups: string[] = [];
mock.module("../../../oauth/oauth-store.js", () => ({
  getProvider: (provider: string) => {
    providerLookups.push(provider);
    return provider === "stripe_link"
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
// readers; only the two auth-bypass readings are pinned. They move
// independently: DISABLE_HTTP_AUTH is set on any host, the platform-managed
// bypass only on a vembda pod.
let httpAuthDisabled = false;
let platformAuthBypass = false;
const env = await import("../../../config/env.js");
mock.module("../../../config/env.js", () => ({
  ...env,
  isHttpAuthDisabled: () => httpAuthDisabled,
  isPlatformAuthBypassActive: () => platformAuthBypass,
}));

const { handleOAuthProxy, ROUTES } = await import("../oauth-proxy-routes.js");
const HTTP_ROUTES = routeDefinitionsToHTTPRoutes(ROUTES);

// ── Harness ─────────────────────────────────────────────────────────────────

const SUBJECT = "local:self:oauth-proxy.stripe_link";
/** Subject of a grant minted with `--account user@example.com`. */
const PINNED_SUBJECT = "local:self:oauth-proxy.stripe_link@user%40example.com";
/** Wire segment the pinned grant's base URL carries. */
const PINNED_SEGMENT = "stripe_link@user%40example.com";

function buildAuthContext(subject: string): AuthContext {
  return {
    subject,
    principalType: "local",
    assistantId: "self",
    conversationId: subject.slice("local:self:".length),
    scopeProfile: "oauth_proxy_v1",
    scopes: resolveScopeProfile("oauth_proxy_v1"),
    policyEpoch: 0,
  };
}

let lastRequest: Request | undefined;

async function callProxy(params: {
  method?: string;
  /** Provider segment exactly as it appears on the wire. */
  segment?: string;
  /** Upstream path, percent-encoding intact. */
  path?: string;
  search?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  subject?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const method = params.method ?? "GET";
  const segment = params.segment ?? "stripe_link";
  const path = params.path ?? "v1/payment_methods";

  // An empty path leaves the provider segment as the whole URL, the shape the
  // route answers with its own 400.
  const suffix = path === "" ? "" : `/${path}`;

  const init: RequestInit = { method, headers: params.headers ?? {} };
  if (params.body !== undefined) {
    init.body = params.body;
  }
  if (params.signal) {
    init.signal = params.signal;
  }
  const req = new Request(
    `http://daemon.local/v1/oauth/proxy/${segment}${suffix}${params.search ?? ""}`,
    init,
  );
  lastRequest = req;

  const httpRoute = HTTP_ROUTES.find((route) => route.method === method);
  if (!httpRoute) {
    throw new Error(`No proxy route registered for ${method}`);
  }

  // Path params exactly as the router derives them: the whole captured group,
  // percent-decoded.
  const url = new URL(req.url);
  const pieces = url.pathname.split("/");

  return await httpRoute.handler({
    req,
    url,
    // The proxy handler never touches `server`.
    server: undefined as never,
    authContext: buildAuthContext(params.subject ?? SUBJECT),
    params: {
      provider: decodeURIComponent(pieces[4]),
      path: decodeURIComponent(pieces.slice(5).join("/")),
    },
  });
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

async function envelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope;
}

/**
 * WHATWG URL parsing resolves `.` and `..` before a handler ever sees them, so
 * dot-segment coverage drives the handler with a URL-shaped stub. Only
 * `pathname` and `search` are read.
 */
// A real URL normalizes dot segments away, so these cases need a hand-built
// pathname. The URL prototype keeps the handler's `instanceof URL` transport
// guard satisfied; JSON over IPC can only ever produce a plain object.
function rawUrlStub(pathname: string, search = ""): URL {
  // Own data properties shadow the prototype accessors, which refuse to run
  // without a real URL's internal slots.
  return Object.create(URL.prototype, {
    pathname: { value: pathname, enumerable: true },
    search: { value: search, enumerable: true },
  }) as URL;
}

function requireCaptured(): OAuthConnectionRequest {
  if (!captured) {
    throw new Error("The connection was never called");
  }
  return captured;
}

beforeEach(() => {
  httpAuthDisabled = false;
  platformAuthBypass = false;
  captured = undefined;
  upstreamBytes = undefined;
  requestError = undefined;
  resolverError = undefined;
  resolverCalls.length = 0;
  providerLookups.length = 0;
  resolution = {
    connection: byoConnection,
    ambiguous: false,
    allAccounts: ["user@example.com"],
  };
  upstream = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  };
});

// ── Path and query fidelity ─────────────────────────────────────────────────

describe("path and query fidelity", () => {
  test("forwards the wire path and repeated query keys, with no body", async () => {
    const response = await callProxy({
      path: "v1/a%2Fb/items/",
      search: "?x=1&x=2&q=a%20b",
    });

    expect(response.status).toBe(200);
    const req = requireCaptured();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/a%2Fb/items/");
    expect(req.query).toEqual({ x: ["1", "2"], q: "a b" });
    expect(req.body).toBeUndefined();
    // The connection's own base is the only host ever targeted.
    expect(req.baseUrl).toBeUndefined();
  });

  test("omits query entirely when the caller sent none", async () => {
    await callProxy({});
    const req = requireCaptured();
    expect(req.query).toBeUndefined();
    expect(req.rawQuery).toBe("");
  });

  test("hands the connection the query bytes alongside the parsed form", async () => {
    await callProxy({ search: "?a=1&b=2&a=3&q=x%20y&flag" });

    const req = requireCaptured();
    // Byte-exact for a provider that signs the query it receives.
    expect(req.rawQuery).toBe("?a=1&b=2&a=3&q=x%20y&flag");
    // The parsed form is all a managed connection can send.
    expect(req.query).toEqual({ a: ["1", "3"], b: "2", q: "x y", flag: "" });
  });

  test("normalizes an inner dot segment", async () => {
    await handleOAuthProxy("GET", {
      pathParams: { provider: "stripe_link" },
      headers: { "x-vellum-subject": SUBJECT },
      rawUrl: rawUrlStub("/v1/oauth/proxy/stripe_link/v1/a/../b"),
    });

    expect(requireCaptured().path).toBe("/v1/b");
  });
});

// ── Methods ─────────────────────────────────────────────────────────────────

describe("method passthrough", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`forwards ${method}`, async () => {
      const response = await callProxy({
        method,
        body: '{"amount":1}',
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      expect(requireCaptured().method).toBe(method);
    });
  }

  test("forwards HEAD and emits no body", async () => {
    upstream = { status: 200, headers: { "x-total": "7" }, body: null };

    const response = await callProxy({ method: "HEAD" });

    expect(requireCaptured().method).toBe("HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-total")).toBe("7");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("rejects HEAD against a managed connection", async () => {
    resolution = { ...resolution, connection: managedConnection() };

    const response = await callProxy({ method: "HEAD" });

    expect(response.status).toBe(405);
    expect(captured).toBeUndefined();
  });
});

// ── Write safety ────────────────────────────────────────────────────────────

describe("write safety", () => {
  for (const method of ["POST", "PATCH"]) {
    test(`a proxied ${method} asks for a single attempt`, async () => {
      await callProxy({ method, body: "{}" });
      expect(requireCaptured().singleAttempt).toBe(true);
    });
  }

  for (const method of ["GET", "PUT", "DELETE"]) {
    test(`a proxied ${method} keeps its retries`, async () => {
      await callProxy({ method });
      expect(requireCaptured().singleAttempt).toBe(false);
    });
  }

  test("a managed write is not replayed after a 502", async () => {
    let attempts = 0;
    resolution = {
      ...resolution,
      connection: realManagedConnection(async () => {
        attempts++;
        return new Response("", { status: 502 });
      }),
    };

    const response = await callProxy({ method: "POST", body: "{}" });

    // The platform answers 502 only after calling the provider, so a replay
    // could land the write twice.
    expect(attempts).toBe(1);
    expect(response.status).toBe(502);
  });
});

// ── Bodies ──────────────────────────────────────────────────────────────────

describe("body passthrough", () => {
  test("forwards invalid JSON bytes verbatim under the caller's content type", async () => {
    const raw = '{"amount": 1,,}';

    await callProxy({
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    });

    const req = requireCaptured();
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString("utf8")).toBe(raw);
    expect(req.headers?.["content-type"]).toBe("application/json");
  });

  test("forwards a form-encoded body as bytes", async () => {
    await callProxy({
      method: "POST",
      body: "a=1&b=two",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const req = requireCaptured();
    expect((req.body as Buffer).toString("utf8")).toBe("a=1&b=two");
    expect(req.headers?.["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("forwards binary bytes untouched", async () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 10]);

    await callProxy({
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });

    const req = requireCaptured();
    expect(Array.from(req.body as Buffer)).toEqual(Array.from(bytes));
  });

  test("sends no body for an empty POST", async () => {
    await callProxy({ method: "POST", body: "" });
    expect(requireCaptured().body).toBeUndefined();
  });
});

// ── Headers ─────────────────────────────────────────────────────────────────

describe("header handling", () => {
  test("strips the daemon credential, framing, and edge headers", async () => {
    await callProxy({
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer local-proxy",
        host: "daemon.local",
        "content-length": "2",
        "accept-encoding": "gzip",
        cookie: "session=abc",
        "x-forwarded-for": "203.0.113.9",
        "x-trace-id": "trace-123",
        "x-vellum-subject": "local:self:spoofed",
        "user-agent": "link-cli/1.0",
        accept: "application/json",
        "content-type": "application/json",
      },
    });

    const headers = requireCaptured().headers ?? {};
    for (const stripped of [
      "authorization",
      "host",
      "content-length",
      "accept-encoding",
      "cookie",
      "x-forwarded-for",
      "x-trace-id",
      "x-vellum-subject",
      "x-vellum-principal-type",
    ]) {
      expect(headers[stripped]).toBeUndefined();
    }
    expect(headers["user-agent"]).toBe("link-cli/1.0");
    expect(headers.accept).toBe("application/json");
  });

  for (const [method, name] of [
    ["PUT", "If-Match"],
    ["DELETE", "If-Match"],
    ["POST", "Idempotency-Key"],
    ["GET", "Range"],
    ["POST", "Prefer"],
    ["GET", "Stripe-Version"],
    ["GET", "X-Custom-Option"],
  ]) {
    test(`rejects managed ${method} with ${name} before the platform call`, async () => {
      let attempts = 0;
      resolution.connection = realManagedConnection(async () => {
        attempts++;
        return Response.json({ status: 200, headers: {}, body: {} });
      });

      const response = await callProxy({
        method,
        headers: { [name]: "private-header-value" },
      });

      expect(response.status).toBe(400);
      const error = (await envelope(response)).error;
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toContain(name.toLowerCase());
      expect(JSON.stringify(error)).not.toContain("private-header-value");
      expect(attempts).toBe(0);
    });
  }

  for (const method of ["GET", "POST"]) {
    test(`forwards managed ${method} with Node CLI defaults and the gateway trace stamp`, async () => {
      let attempts = 0;
      const forwardedHeaders = {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "link-cli/1.0",
        "x-request-id": "request-123",
      };
      resolution.connection = realManagedConnection(async (_path, init) => {
        attempts++;
        const body = JSON.parse(init?.body as string);
        expect(body.request.headers).toEqual(forwardedHeaders);
        return Response.json({ status: 200, headers: {}, body: {} });
      });

      const response = await callProxy({
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
        headers: {
          ...forwardedHeaders,
          "accept-language": "*",
          "sec-fetch-mode": "cors",
          "accept-encoding": "gzip, deflate",
          connection: "keep-alive",
          "x-trace-id": "trace-123",
        },
      });

      expect(response.status).toBe(200);
      expect(attempts).toBe(1);
    });
  }

  test("rejects non-default managed fetch metadata and language preferences", async () => {
    resolution.connection = managedConnection();
    const response = await callProxy({
      headers: { "Sec-Fetch-Mode": "navigate", "Accept-Language": "en" },
    });

    expect(response.status).toBe(400);
    expect((await envelope(response)).error.message).toContain(
      "accept-language, sec-fetch-mode",
    );
    expect(captured).toBeUndefined();
  });

  test("preserves conditional and custom headers on a BYO connection", async () => {
    const headers = {
      "if-match": '"version-1"',
      "idempotency-key": "request-123",
      "stripe-version": "2024-06-20",
      "x-custom-option": "example",
    };
    const response = await callProxy({ method: "PUT", headers, body: "{}" });

    expect(response.status).toBe(200);
    expect(requireCaptured().headers).toMatchObject(headers);
  });
});

// ── Raw emission ────────────────────────────────────────────────────────────

describe("response emission", () => {
  test("preserves the provider status and headers, reframing the length", async () => {
    upstream = {
      status: 201,
      headers: {
        "content-type": "application/json",
        "x-rate-limit-remaining": "9",
        "content-length": "999",
      },
      body: { id: "pm_1" },
    };

    const response = await callProxy({ method: "POST", body: "{}" });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-rate-limit-remaining")).toBe("9");
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(await response.text()).toBe(JSON.stringify({ id: "pm_1" }));
  });

  test("round-trips binary bytes", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    upstream = {
      status: 200,
      headers: { "content-type": "image/png" },
      body: bytes,
    };

    const response = await callProxy({});

    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(bytes),
    );
  });

  test("round-trips a BYO JSON payload byte for byte", async () => {
    // Whitespace, a repeated key, and an integer past 2^53: all three are lost
    // or corrupted by a JSON.parse/JSON.stringify round trip.
    const raw = Buffer.from(
      '{\n  "id": "pm_1",\n  "amount":   9007199254740993,\n  "id": "pm_2"\n}\n',
      "utf8",
    );
    upstreamBytes = raw;
    upstream = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: null,
    };

    const response = await callProxy({});

    expect(requireCaptured().rawResponseBody).toBe(true);
    const emitted = Buffer.from(await response.arrayBuffer());
    expect(emitted.equals(raw)).toBe(true);
  });

  test("hands the caller the provider's redirect rather than following it", async () => {
    upstream = {
      status: 302,
      headers: {
        location: "https://files.stripe.com/blob/abc",
        "content-type": "text/plain",
      },
      body: "moved",
    };

    const response = await callProxy({ method: "POST", body: "{}" });

    expect(requireCaptured().manualRedirect).toBe(true);
    expect(response.status).toBe(302);
    // The target moves off `location` so no client auto-follows it back to the
    // provider carrying the proxy grant as its bearer token.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-vellum-proxy-location")).toBe(
      "https://files.stripe.com/blob/abc",
    );
  });

  test("emits a 204 with no body through the route adapter", async () => {
    // The adapter's own null-body short-circuit reads the route's declared
    // status, which is 200 here, so a provider 204 has to survive the
    // handler-supplied-response branch instead.
    upstream = {
      status: 204,
      headers: { "x-request-id": "req_1" },
      body: null,
    };

    const response = await callProxy({ method: "DELETE" });

    expect(response.status).toBe(204);
    expect(response.headers.get("x-request-id")).toBe("req_1");
    expect(await response.text()).toBe("");
  });

  test("emits a string body as UTF-8", async () => {
    upstream = {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "héllo",
    };

    const response = await callProxy({});

    expect(await response.text()).toBe("héllo");
  });
});

// ── Connection selection ────────────────────────────────────────────────────

describe("connection selection", () => {
  test("refuses to pick when several accounts match", async () => {
    resolution = {
      connection: byoConnection,
      ambiguous: true,
      allAccounts: ["a@example.com", "b@example.com"],
    };

    const response = await callProxy({});

    expect(response.status).toBe(409);
    const { error } = await envelope(response);
    // The grant holder is a third party, so the accounts are named only at
    // mint time. Here the caller is told to mint a grant pinned to one.
    expect(error.details).toEqual({ provider: "stripe_link" });
    expect(error.message).not.toContain("a@example.com");
    expect(error.message).not.toContain("b@example.com");
    expect(captured).toBeUndefined();
  });
});

// ── Failure mapping ─────────────────────────────────────────────────────────

describe("failure mapping", () => {
  test("unknown provider is a 404 in the error envelope", async () => {
    const response = await callProxy({
      segment: "nope",
      subject: "local:self:oauth-proxy.nope",
    });

    expect(response.status).toBe(404);
    const { error } = await envelope(response);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("nope");
    expect(resolverCalls).toHaveLength(0);
  });

  test("an unresolvable connection is a 424 that names the reconnect command", async () => {
    resolverError = new Error("No active stripe_link connection");

    const response = await callProxy({});

    expect(response.status).toBe(424);
    const { error } = await envelope(response);
    expect(error.details?.reconnect).toBe(
      "assistant oauth connect stripe_link",
    );
  });

  test("a dead credential is a 424", async () => {
    requestError = new CredentialRequiredError();

    const response = await callProxy({});

    expect(response.status).toBe(424);
    expect((await envelope(response)).error.details?.reconnect).toBe(
      "assistant oauth connect stripe_link",
    );
  });

  test("an empty balance is a 402", async () => {
    requestError = new InsufficientBalanceError();
    expect((await callProxy({})).status).toBe(402);
  });

  test("an unreachable provider is a 502", async () => {
    requestError = new ProviderUnreachableError();
    expect((await callProxy({})).status).toBe(502);
  });

  test("an unusable managed status is a mapped 502, not an opaque 500", async () => {
    resolution = {
      ...resolution,
      connection: realManagedConnection(async () => {
        return new Response(
          JSON.stringify({ status: 700, headers: {}, body: null }),
          { status: 200 },
        );
      }),
    };

    // Handing 700 to `new Response` would throw a RangeError, which is not a
    // RouteError and reaches the caller as a bare 500.
    const response = await callProxy({});

    expect(response.status).toBe(502);
    expect((await envelope(response)).error.code).toBe("BAD_GATEWAY");
  });
});

// ── Grant binding, path safety, transport guard ─────────────────────────────

describe("grant binding", () => {
  /** Nothing downstream of the subject check ran. */
  async function expectRefusedBeforeResolution(
    response: Response,
  ): Promise<void> {
    expect(response.status).toBe(403);
    expect((await envelope(response)).error.code).toBe("FORBIDDEN");
    expect(resolverCalls).toHaveLength(0);
    expect(providerLookups).toHaveLength(0);
    expect(captured).toBeUndefined();
  }

  test("a grant for another provider is rejected before resolution", async () => {
    const response = await callProxy({
      subject: "local:self:oauth-proxy.google",
    });

    await expectRefusedBeforeResolution(response);
  });

  test("a grant pinned to an account reaches that account", async () => {
    const response = await callProxy({
      segment: PINNED_SEGMENT,
      subject: PINNED_SUBJECT,
    });

    expect(response.status).toBe(200);
    expect(resolverCalls).toEqual([
      { provider: "stripe_link", options: { account: "user@example.com" } },
    ]);
  });

  test("a pinned grant cannot be rewritten onto another account", async () => {
    const response = await callProxy({
      segment: "stripe_link@other%40example.com",
      subject: PINNED_SUBJECT,
    });

    await expectRefusedBeforeResolution(response);
  });

  test("a pinned grant cannot fall back to the default connection", async () => {
    // The bare segment resolves to whichever connection the resolver prefers,
    // which is not necessarily the one the grant was minted for.
    const response = await callProxy({ subject: PINNED_SUBJECT });

    await expectRefusedBeforeResolution(response);
  });

  test("an unpinned grant works against the bare provider segment", async () => {
    const response = await callProxy({ subject: SUBJECT });

    expect(response.status).toBe(200);
    expect(resolverCalls).toEqual([
      { provider: "stripe_link", options: undefined },
    ]);
  });

  test("an unpinned grant cannot name an account of its own", async () => {
    // Unpinned means the mint identified no account, so any account the caller
    // supplies here is one the grant never stood for.
    const response = await callProxy({
      segment: PINNED_SEGMENT,
      subject: SUBJECT,
    });

    await expectRefusedBeforeResolution(response);
  });

  test("a colon in the provider segment fails parsing before any subject check", async () => {
    const response = await callProxy({ segment: "vendor%3Aregion" });

    expect(response.status).toBe(400);
    const { error } = await envelope(response);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toContain("Invalid OAuth proxy provider key");
    expect(resolverCalls).toHaveLength(0);
  });

  test("a platform-managed pod skips the comparison it has no subject for", async () => {
    // The pod's daemon discards the token and synthesizes a context, so the
    // grant's subject never reaches the handler.
    httpAuthDisabled = true;
    platformAuthBypass = true;

    const response = await callProxy({ subject: "actor:self:dev-bypass" });

    expect(response.status).toBe(200);
  });

  test("DISABLE_HTTP_AUTH off a platform pod still binds the grant", async () => {
    httpAuthDisabled = true;

    const response = await callProxy({ subject: "actor:self:dev-bypass" });

    await expectRefusedBeforeResolution(response);
  });
});

describe("path safety", () => {
  test("an authority-style path is refused before resolution", async () => {
    const response = await callProxy({ path: "/evil.example/x" });

    expect(response.status).toBe(400);
    expect(resolverCalls).toHaveLength(0);
  });

  test("a root-escaping dot segment is refused before resolution", async () => {
    await expect(
      handleOAuthProxy("GET", {
        pathParams: { provider: "stripe_link" },
        headers: { "x-vellum-subject": SUBJECT },
        rawUrl: rawUrlStub("/v1/oauth/proxy/stripe_link/../../etc"),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(resolverCalls).toHaveLength(0);
  });

  test("a provider segment with no API path after it is a 400", async () => {
    const response = await callProxy({ path: "" });

    expect(response.status).toBe(400);
    const { error } = await envelope(response);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toContain("A provider API path is required");
    expect(resolverCalls).toHaveLength(0);
  });
});

describe("transport guard", () => {
  test("an IPC invocation never reaches the provider and asks for HTTP", async () => {
    const args: RouteHandlerArgs = {
      pathParams: { provider: "stripe_link" },
      headers: { "x-vellum-subject": SUBJECT },
    };

    // The gateway's IPC proxy reads this code as "retry over HTTP", so the
    // caller is served rather than hard-failed.
    await expect(
      Promise.resolve(ROUTES[0].handler(args)),
    ).rejects.toMatchObject({
      statusCode: 421,
      code: "BINARY_UNSUPPORTED_OVER_IPC",
    });
    expect(resolverCalls).toHaveLength(0);
    expect(captured).toBeUndefined();
  });

  test("a forged plain-object rawUrl is refused before the provider", async () => {
    // An IPC caller controls every handler arg, and the handler reads only
    // pathname and search, so a truthiness guard would have let this through
    // to a real provider call carrying the user's credential.
    const args = {
      pathParams: { provider: "stripe_link" },
      headers: { "x-vellum-subject": SUBJECT },
      rawUrl: { pathname: "/v1/oauth/proxy/stripe_link/v1/me", search: "" },
    } as unknown as RouteHandlerArgs;

    await expect(
      Promise.resolve(ROUTES[0].handler(args)),
    ).rejects.toMatchObject({
      statusCode: 421,
      code: "BINARY_UNSUPPORTED_OVER_IPC",
    });
    expect(resolverCalls).toHaveLength(0);
    expect(captured).toBeUndefined();
  });

  test("every proxy route declares the 421 it can throw", () => {
    for (const route of ROUTES) {
      expect(route.additionalResponses?.["421"]).toBeDefined();
    }
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe("cancellation", () => {
  test("hands the connection the request's abort signal", async () => {
    const controller = new AbortController();

    await callProxy({ signal: controller.signal });

    expect(requireCaptured().signal).toBe(lastRequest?.signal);
  });
});
