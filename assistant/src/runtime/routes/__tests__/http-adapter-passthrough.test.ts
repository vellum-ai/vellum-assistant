/**
 * Tests for the HTTP adapter's passthrough primitives: wire-exact `rawUrl`,
 * unparsed `rawBody` under `rawRequestBody`, and the verified
 * `x-vellum-subject` header.
 *
 * A proxy handler forwards what the caller actually sent, so the adapter must
 * not normalize the URL, parse the body, or trust a caller-supplied subject.
 */

import { describe, expect, test } from "bun:test";

import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext } from "../../auth/types.js";
import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";
import type { RouteDefinition } from "../types.js";

interface EchoResult {
  body: Record<string, unknown> | null;
  rawBody: number[] | null;
  rawPathname: string | null;
  rawSearch: string | null;
  queryParams: Record<string, string>;
  subject: string | null;
}

function echoRoute(rawRequestBody?: boolean): RouteDefinition {
  return {
    operationId: "echo_passthrough",
    endpoint: "test/echo-passthrough",
    method: "POST",
    policy: null,
    // Omitted, not `false`, when unset: the adapter's default path is what
    // the regression guard exercises.
    ...(rawRequestBody === undefined ? {} : { rawRequestBody }),
    handler: ({ body, rawBody, rawUrl, queryParams, headers }) => ({
      body: body ?? null,
      rawBody: rawBody ? Array.from(rawBody) : null,
      rawPathname: rawUrl?.pathname ?? null,
      rawSearch: rawUrl?.search ?? null,
      queryParams: queryParams ?? {},
      subject: headers?.["x-vellum-subject"] ?? null,
    }),
  };
}

function buildAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    subject: "local:self:abc",
    principalType: "local",
    assistantId: "self",
    scopeProfile: "local_v1",
    scopes: resolveScopeProfile("local_v1"),
    policyEpoch: 0,
    ...overrides,
  };
}

async function invokeEcho(params: {
  rawRequestBody?: boolean;
  requestUrl?: string;
  contentType?: string;
  body?: BodyInit;
  requestHeaders?: Record<string, string>;
  authContext?: AuthContext;
}): Promise<EchoResult> {
  const [httpRoute] = routeDefinitionsToHTTPRoutes([
    echoRoute(params.rawRequestBody),
  ]);

  const headers: Record<string, string> = { ...params.requestHeaders };
  if (params.contentType) {
    headers["content-type"] = params.contentType;
  }

  const req = new Request(
    params.requestUrl ?? "http://daemon.local/v1/test/echo-passthrough",
    { method: "POST", headers, body: params.body },
  );

  const response = await httpRoute.handler({
    req,
    url: new URL(req.url),
    // The echo handler doesn't touch `server`; a stub is fine.
    server: undefined as never,
    authContext: params.authContext ?? buildAuthContext(),
    params: {},
  });

  return (await response.json()) as EchoResult;
}

function bytesOf(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

describe("http-adapter rawRequestBody", () => {
  test("delivers unparsed bytes for a JSON content-type with an invalid body", async () => {
    const payload = "{not: valid json,,,}";

    const result = await invokeEcho({
      rawRequestBody: true,
      contentType: "application/json",
      body: payload,
    });

    expect(result.rawBody).toEqual(bytesOf(payload));
    expect(result.body).toBeNull();
  });

  test("delivers form-encoded bytes untouched", async () => {
    const payload = "grant_type=client_credentials&scope=a+b";

    const result = await invokeEcho({
      rawRequestBody: true,
      contentType: "application/x-www-form-urlencoded",
      body: payload,
    });

    expect(result.rawBody).toEqual(bytesOf(payload));
    expect(result.body).toBeNull();
  });

  test("delivers binary bytes untouched", async () => {
    const payload = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80]);

    const result = await invokeEcho({
      rawRequestBody: true,
      contentType: "application/octet-stream",
      body: payload,
    });

    expect(result.rawBody).toEqual(Array.from(payload));
    expect(result.body).toBeNull();
  });

  test("parses JSON as usual when the flag is absent", async () => {
    const result = await invokeEcho({
      contentType: "application/json",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(result.body).toEqual({ hello: "world" });
    expect(result.rawBody).toBeNull();
  });
});

describe("http-adapter rawUrl", () => {
  test("keeps percent-encoding and repeated query keys the parsed params collapse", async () => {
    const result = await invokeEcho({
      requestUrl:
        "http://daemon.local/v1/test/echo%2Fpassthrough?x=1&x=2&y=a%20b",
      contentType: "application/json",
      body: JSON.stringify({}),
    });

    expect(result.rawPathname).toBe("/v1/test/echo%2Fpassthrough");
    expect(result.rawSearch).toBe("?x=1&x=2&y=a%20b");
    expect(result.queryParams.x).toBe("2");
    expect(result.queryParams.y).toBe("a b");
  });
});

describe("http-adapter subject header", () => {
  test("replaces a caller-supplied subject with the verified one", async () => {
    const result = await invokeEcho({
      contentType: "application/json",
      body: JSON.stringify({}),
      requestHeaders: { "x-vellum-subject": "local:self:spoofed" },
      authContext: buildAuthContext({ subject: "local:self:abc" }),
    });

    expect(result.subject).toBe("local:self:abc");
  });

  test("injects the verified subject when the caller sends none", async () => {
    const result = await invokeEcho({
      contentType: "application/json",
      body: JSON.stringify({}),
      authContext: buildAuthContext({ subject: "local:self:oauth-proxy.demo" }),
    });

    expect(result.subject).toBe("local:self:oauth-proxy.demo");
  });
});
