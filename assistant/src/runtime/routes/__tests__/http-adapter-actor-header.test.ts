/**
 * Regression tests for actor/principal header sanitization in the HTTP
 * adapter.
 *
 * The HTTP adapter must derive the actor identity headers
 * (`x-vellum-actor-principal-id`, `x-vellum-principal-type`) exclusively from
 * the verified AuthContext, never from caller-supplied request headers. A
 * caller whose token carries no actorPrincipalId (svc_gateway / svc_daemon /
 * local principals) must not be able to spoof another principal — e.g. the
 * guardian — by setting the header explicitly. This protects principal-gated
 * handlers (surface action `apr:*` guardian decisions, guardian actions, host
 * proxies) from approval-token bypass via a forged actor principal.
 */

import { describe, expect, test } from "bun:test";

import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext } from "../../auth/types.js";
import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";
import type { RouteDefinition } from "../types.js";

// Echo route: returns the identity headers the handler actually observed.
const ECHO_ROUTE: RouteDefinition = {
  operationId: "echo_identity_headers",
  endpoint: "test/echo-identity",
  method: "POST",
  policy: null,
  handler: ({ headers }) => ({
    actorPrincipalId: headers?.["x-vellum-actor-principal-id"] ?? null,
    principalType: headers?.["x-vellum-principal-type"] ?? null,
  }),
};

function buildAuthContext(overrides: Partial<AuthContext>): AuthContext {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway",
    assistantId: "self",
    scopeProfile: "gateway_service_v1",
    scopes: resolveScopeProfile("gateway_service_v1"),
    policyEpoch: 0,
    ...overrides,
  };
}

async function invokeEcho(params: {
  spoofedPrincipalId?: string;
  spoofedPrincipalType?: string;
  authContext: AuthContext;
}): Promise<{ actorPrincipalId: string | null; principalType: string | null }> {
  const [httpRoute] = routeDefinitionsToHTTPRoutes([ECHO_ROUTE]);

  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  if (params.spoofedPrincipalId !== undefined) {
    reqHeaders["x-vellum-actor-principal-id"] = params.spoofedPrincipalId;
  }
  if (params.spoofedPrincipalType !== undefined) {
    reqHeaders["x-vellum-principal-type"] = params.spoofedPrincipalType;
  }

  const req = new Request("http://daemon.local/v1/test/echo-identity", {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify({}),
  });

  const response = await httpRoute.handler({
    req,
    url: new URL(req.url),
    // The echo handler doesn't touch `server`; a stub is fine.
    server: undefined as never,
    authContext: params.authContext,
    params: {},
  });

  return (await response.json()) as {
    actorPrincipalId: string | null;
    principalType: string | null;
  };
}

describe("http-adapter actor/principal header sanitization", () => {
  test("drops a spoofed actor-principal header when the context has no actorPrincipalId", async () => {
    // A service token (svc_gateway) has no actorPrincipalId. The forged header
    // must be stripped, not passed through to the handler.
    const result = await invokeEcho({
      spoofedPrincipalId: "guardian-principal-victim",
      authContext: buildAuthContext({ actorPrincipalId: undefined }),
    });

    expect(result.actorPrincipalId).toBeNull();
    // principalType is always re-derived from the verified context.
    expect(result.principalType).toBe("svc_gateway");
  });

  test("overrides a spoofed actor-principal header with the verified context value", async () => {
    const result = await invokeEcho({
      spoofedPrincipalId: "guardian-principal-victim",
      spoofedPrincipalType: "actor",
      authContext: buildAuthContext({
        subject: "actor:self:real-actor",
        principalType: "actor",
        scopeProfile: "actor_client_v1",
        scopes: resolveScopeProfile("actor_client_v1"),
        actorPrincipalId: "real-actor",
      }),
    });

    expect(result.actorPrincipalId).toBe("real-actor");
    expect(result.principalType).toBe("actor");
  });

  test("passes through the genuine actor identity when no spoof is present", async () => {
    const result = await invokeEcho({
      authContext: buildAuthContext({
        subject: "actor:self:real-actor",
        principalType: "actor",
        scopeProfile: "actor_client_v1",
        scopes: resolveScopeProfile("actor_client_v1"),
        actorPrincipalId: "real-actor",
      }),
    });

    expect(result.actorPrincipalId).toBe("real-actor");
    expect(result.principalType).toBe("actor");
  });
});
