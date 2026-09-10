/**
 * Tests for route policy enforcement.
 *
 * With policy-on-route (ATL-315 followup), each route owns its own
 * `policy: RoutePolicy | null` and the HTTP server / IPC adapter pass
 * that policy directly to `enforcePolicy()`. There is no longer a
 * side-registry to look up against.
 *
 * Covers:
 * - `policy: null` is unprotected for a broad profile, closed to a grant
 *   minted for a single route
 * - Principal type check denies disallowed types
 * - Scope check denies missing scopes
 * - Allowed requests return null
 * - Dev bypass allows all requests through
 * - Sample assertions against canonical ROUTES entries to make sure
 *   the policy field is wired through to representative endpoints
 *   (channels/inbound, internal/twilio/voice-webhook, etc.) — these
 *   replace the prior "registry contents" tests.
 */

import { describe, expect, mock, test } from "bun:test";

// Track auth bypass state for tests
let authDisabled = false;
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

import { enforcePolicy, type RoutePolicy } from "../route-policy.js";
import { resolveScopeProfile } from "../scopes.js";
import type { AuthContext, Scope } from "../types.js";

/** Build a synthetic AuthContext for testing. */
function buildTestContext(overrides?: {
  principalType?: AuthContext["principalType"];
  scopes?: Scope[];
  scopeProfile?: AuthContext["scopeProfile"];
}): AuthContext {
  return {
    subject: "actor:self:test-principal",
    principalType: overrides?.principalType ?? "actor",
    assistantId: "self",
    actorPrincipalId: "test-principal",
    scopeProfile: overrides?.scopeProfile ?? "actor_client_v1",
    scopes: new Set(
      overrides?.scopes ?? [
        "chat.read",
        "chat.write",
        "approval.read",
        "approval.write",
      ],
    ),
    policyEpoch: 0,
  };
}

/** Canonical actor-write policy used by most chat endpoints. */
const ACTOR_WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["chat.write"],
  allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
};

/** Canonical gateway-only policy used by inbound webhook endpoints. */
const GATEWAY_INGRESS_POLICY: RoutePolicy = {
  requiredScopes: ["ingress.write"],
  allowedPrincipalTypes: ["svc_gateway"],
};

/** Policy guarding the OAuth passthrough route. */
const OAUTH_PROXY_POLICY: RoutePolicy = {
  requiredScopes: ["oauth.proxy"],
  allowedPrincipalTypes: ["local"],
};

describe("enforcePolicy", () => {
  test("policy: null is unprotected for a broad scope profile", () => {
    authDisabled = false;
    const ctx = buildTestContext({ scopes: [] });
    const result = enforcePolicy("_internal/health", null, ctx);
    expect(result).toBeNull();
  });

  test("returns 403 when principal type is not allowed", () => {
    authDisabled = false;
    // Actor trying to call a gateway-only ingress endpoint
    const ctx = buildTestContext({
      principalType: "actor",
      scopes: ["ingress.write"],
    });
    const result = enforcePolicy(
      "channels/inbound",
      GATEWAY_INGRESS_POLICY,
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("returns 403 when required scope is missing", () => {
    authDisabled = false;
    // Actor missing chat.write
    const ctx = buildTestContext({ scopes: ["chat.read"] });
    const result = enforcePolicy("messages", ACTOR_WRITE_POLICY, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("allows actor with required scope and allowed principal type", () => {
    authDisabled = false;
    const ctx = buildTestContext({ scopes: ["chat.write"] });
    const result = enforcePolicy("messages", ACTOR_WRITE_POLICY, ctx);
    expect(result).toBeNull();
  });

  test("allows svc_gateway with ingress.write on channels/inbound", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "svc_gateway",
      scopes: ["ingress.write"],
    });
    const result = enforcePolicy(
      "channels/inbound",
      GATEWAY_INGRESS_POLICY,
      ctx,
    );
    expect(result).toBeNull();
  });

  test("dev bypass allows all requests through regardless of policy", () => {
    authDisabled = true;
    // Actor trying to call channels/inbound (which requires svc_gateway)
    const ctx = buildTestContext({ principalType: "actor", scopes: [] });
    const result = enforcePolicy(
      "channels/inbound",
      GATEWAY_INGRESS_POLICY,
      ctx,
    );
    expect(result).toBeNull();
    authDisabled = false;
  });

  test("rejects request when ANY required scope is missing", () => {
    authDisabled = false;
    const multiScopePolicy: RoutePolicy = {
      requiredScopes: ["chat.write", "approval.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    };
    // Has chat.write but not approval.write
    const ctx = buildTestContext({ scopes: ["chat.write"] });
    const result = enforcePolicy("compound", multiScopePolicy, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("allows a local principal holding oauth.proxy", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "local",
      scopes: ["oauth.proxy"],
    });
    expect(enforcePolicy("oauth/proxy", OAUTH_PROXY_POLICY, ctx)).toBeNull();
  });

  test("oauth.proxy opens no other route", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "local",
      scopes: ["oauth.proxy"],
    });
    const result = enforcePolicy(
      "settings",
      { requiredScopes: ["settings.write"], allowedPrincipalTypes: ["local"] },
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("a fully scoped actor client cannot reach the oauth proxy route", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "actor",
      scopes: [...resolveScopeProfile("actor_client_v1")],
    });
    const result = enforcePolicy("oauth/proxy", OAUTH_PROXY_POLICY, ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("an unrecognized profile is refused on a route naming no scope", () => {
    authDisabled = false;
    // Claims come from JSON, so a profile outside the union reaches this, and
    // a prototype key resolves to an object rather than the `true` a broad
    // profile carries.
    for (const profile of ["bogus_v1", "__proto__", "constructor"]) {
      const ctx = buildTestContext({
        scopeProfile: profile as never,
        scopes: [],
      });
      const result = enforcePolicy("_internal/health", null, ctx);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    }
  });

  test("empty requiredScopes admits a broad-profile principal of allowed type", () => {
    authDisabled = false;
    const openPolicy: RoutePolicy = {
      requiredScopes: [],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    };
    const ctx = buildTestContext({ scopes: [] });
    const result = enforcePolicy("open", openPolicy, ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-route grants
//
// An oauth_proxy_v1 grant is printed for a user to export into a stock
// third-party CLI's environment, so it sits outside this install's trust
// boundary. `policy: null` admits any valid token, which for this grant means
// mutating routes it was never minted for (integrations/a2a/invite/accept).
// ---------------------------------------------------------------------------

/** The context an exported OAuth proxy grant produces. */
function buildProxyGrantContext(): AuthContext {
  return {
    ...buildTestContext({
      principalType: "local",
      scopes: [...resolveScopeProfile("oauth_proxy_v1")],
      scopeProfile: "oauth_proxy_v1",
    }),
    subject: "local:self:oauth-proxy.stripe_link",
    actorPrincipalId: undefined,
    conversationId: "oauth-proxy.stripe_link",
  };
}

describe("enforcePolicy with an oauth_proxy_v1 grant", () => {
  test("denies an unprotected route", () => {
    authDisabled = false;
    const result = enforcePolicy(
      "integrations/a2a/invite/accept",
      null,
      buildProxyGrantContext(),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("denies a policy that names no scope", () => {
    authDisabled = false;
    const result = enforcePolicy(
      "open",
      { requiredScopes: [], allowedPrincipalTypes: ["local"] },
      buildProxyGrantContext(),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("allows the passthrough policy", () => {
    authDisabled = false;
    expect(
      enforcePolicy(
        "oauth/proxy",
        OAUTH_PROXY_POLICY,
        buildProxyGrantContext(),
      ),
    ).toBeNull();
  });

  test("denies a settings.write policy", () => {
    authDisabled = false;
    const result = enforcePolicy(
      "settings",
      { requiredScopes: ["settings.write"], allowedPrincipalTypes: ["local"] },
      buildProxyGrantContext(),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("the dev bypass still admits it", () => {
    authDisabled = true;
    expect(
      enforcePolicy(
        "integrations/a2a/invite/accept",
        null,
        buildProxyGrantContext(),
      ),
    ).toBeNull();
    authDisabled = false;
  });

  test("a local CLI token still reaches an unprotected route", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "local",
      scopes: [...resolveScopeProfile("local_v1")],
      scopeProfile: "local_v1",
    });
    expect(
      enforcePolicy("integrations/a2a/invite/accept", null, ctx),
    ).toBeNull();
  });

  test("the passthrough ROUTES entries admit the grant", async () => {
    authDisabled = false;
    const { ROUTES } = await import("../../routes/index.js");
    const proxyRoutes = ROUTES.filter((r) =>
      r.operationId.startsWith("oauth_proxy_"),
    );
    expect(proxyRoutes.length).toBeGreaterThan(1);
    const ctx = buildProxyGrantContext();
    for (const route of proxyRoutes) {
      const result = enforcePolicy(route.endpoint, route.policy, ctx);
      if (route.operationId === "oauth_proxy_grant") {
        // Minting takes settings.write, so a grant cannot mint another.
        expect(result!.status).toBe(403);
      } else {
        expect(result).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: representative ROUTES entries carry the expected policy
//
// Replaces the prior "registry contents" tests. With policy-on-route, the
// canonical assertion is "the route declaration carries the policy I expect"
// — checked by importing ROUTES and reading `.policy` directly.
// ---------------------------------------------------------------------------

describe("ROUTES policy declarations", () => {
  test("channels/inbound declares gateway-only ingress policy", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "channels/inbound" && r.method === "POST",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(route!.policy!.requiredScopes).toContain("ingress.write");
  });

  test("internal/twilio/voice-webhook is gateway-only", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "internal/twilio/voice-webhook",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(route!.policy!.requiredScopes).toContain("internal.write");
  });

  test("messages POST is an actor-write endpoint", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "messages" && r.method === "POST",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("actor");
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).toContain("local");
    expect(route!.policy!.requiredScopes).toContain("chat.write");
  });

  test("platform/status is readable by browser actors", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "platform/status" && r.method === "GET",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("actor");
    expect(route!.policy!.allowedPrincipalTypes).toContain("local");
    expect(route!.policy!.requiredScopes).toContain("settings.read");
  });

  test("confirm declares an approval-write policy", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find((r) => r.endpoint === "confirm");
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.requiredScopes).toContain("approval.write");
  });

  test("stt/transcribe declares chat.write with all standard principals", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find((r) => r.endpoint === "stt/transcribe");
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.requiredScopes).toContain("chat.write");
    expect(route!.policy!.allowedPrincipalTypes).toContain("actor");
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_daemon");
    expect(route!.policy!.allowedPrincipalTypes).toContain("local");
  });

  test("contacts/invites/:id/call is gateway-only", async () => {
    // The handler dials whatever number the body supplies — the invite
    // validation lives in the gateway's triggerInviteCallNative, so an
    // actor-reachable policy would be an arbitrary-outbound-call primitive.
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find((r) => r.operationId === "invites_trigger_call");
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toEqual(["svc_gateway"]);
    expect(route!.policy!.requiredScopes).toContain("internal.write");

    // An actor principal with settings.write is denied.
    authDisabled = false;
    const actorCtx = buildTestContext({
      principalType: "actor",
      scopes: ["settings.write"],
    });
    const denied = enforcePolicy(route!.endpoint, route!.policy!, actorCtx);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);

    // The gateway service principal with internal.write is allowed.
    const gatewayCtx = buildTestContext({
      principalType: "svc_gateway",
      scopes: ["internal.write"],
    });
    expect(
      enforcePolicy(route!.endpoint, route!.policy!, gatewayCtx),
    ).toBeNull();
  });

  test("internal/oauth/connect/start is gateway-only", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "internal/oauth/connect/start",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(route!.policy!.requiredScopes).toContain("internal.write");
  });

  test("internal/oauth/connect/status/:state is gateway-only", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const route = ROUTES.find(
      (r) => r.endpoint === "internal/oauth/connect/status/:state",
    );
    expect(route).toBeDefined();
    expect(route!.policy).not.toBeNull();
    expect(route!.policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route!.policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(route!.policy!.requiredScopes).toContain("internal.write");
  });

  test("every route declares a policy field (no undefined)", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    for (const r of ROUTES) {
      // policy is required: must be RoutePolicy or null, never undefined.
      expect(r.policy === null || typeof r.policy === "object").toBe(true);
    }
  });

  test.each([
    ["integrations_vercel_config_get", "settings.read"],
    ["integrations_vercel_config_post", "settings.write"],
    ["integrations_vercel_config_delete", "settings.write"],
    ["integrations_a2a_config_get", "settings.read"],
    ["integrations_a2a_config_post", "settings.write"],
    ["integrations_a2a_config_delete", "settings.write"],
  ] as const)(
    "%s requires %s and actor principals",
    async (operationId, scope) => {
      const { ROUTES } = await import("../../routes/index.js");
      const route = ROUTES.find((r) => r.operationId === operationId);
      expect(route).toBeDefined();
      expect(route!.policy).not.toBeNull();
      expect(route!.policy!.requiredScopes).toEqual([scope]);
      expect(route!.policy!.allowedPrincipalTypes).toEqual([
        "actor",
        "svc_gateway",
        "svc_daemon",
        "local",
      ]);
    },
  );

  test("vercel config GET denies a chat-only actor and POST denies without settings.write", async () => {
    const { ROUTES } = await import("../../routes/index.js");
    const getRoute = ROUTES.find(
      (r) => r.operationId === "integrations_vercel_config_get",
    );
    const postRoute = ROUTES.find(
      (r) => r.operationId === "integrations_vercel_config_post",
    );
    expect(getRoute?.policy).not.toBeNull();
    expect(postRoute?.policy).not.toBeNull();

    authDisabled = false;
    const chatOnly = buildTestContext({
      principalType: "actor",
      scopes: ["chat.read", "chat.write"],
    });
    const getDenied = enforcePolicy(
      getRoute!.endpoint,
      getRoute!.policy!,
      chatOnly,
    );
    expect(getDenied).not.toBeNull();
    expect(getDenied!.status).toBe(403);

    const postDenied = enforcePolicy(
      postRoute!.endpoint,
      postRoute!.policy!,
      chatOnly,
    );
    expect(postDenied).not.toBeNull();
    expect(postDenied!.status).toBe(403);

    const settingsActor = buildTestContext({
      principalType: "actor",
      scopes: ["settings.write"],
    });
    expect(
      enforcePolicy(postRoute!.endpoint, postRoute!.policy!, settingsActor),
    ).toBeNull();
  });
});
