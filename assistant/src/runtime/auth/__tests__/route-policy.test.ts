/**
 * Tests for route policy enforcement.
 *
 * With policy-on-route (ATL-315 followup), each route owns its own
 * `policy: RoutePolicy | null` and the HTTP server / IPC adapter pass
 * that policy directly to `enforcePolicy()`. There is no longer a
 * side-registry to look up against.
 *
 * Covers:
 * - `policy: null` is treated as unprotected (always allowed)
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
import type { AuthContext, Scope } from "../types.js";

/** Build a synthetic AuthContext for testing. */
function buildTestContext(overrides?: {
  principalType?: AuthContext["principalType"];
  scopes?: Scope[];
}): AuthContext {
  return {
    subject: "actor:self:test-principal",
    principalType: overrides?.principalType ?? "actor",
    assistantId: "self",
    actorPrincipalId: "test-principal",
    scopeProfile: "actor_client_v1",
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

describe("enforcePolicy", () => {
  test("policy: null is treated as unprotected (always allowed)", () => {
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

  test("empty requiredScopes admits any principal of allowed type", () => {
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
});
