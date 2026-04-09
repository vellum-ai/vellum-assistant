/**
 * Tests for route policy enforcement (enforcePolicy).
 *
 * Covers:
 * - Unregistered endpoints return null (allowed)
 * - Principal type check denies disallowed types
 * - Scope check denies missing scopes
 * - Allowed requests return null
 * - Channel inbound requires svc_gateway principal type
 * - Dev bypass allows all requests through
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track auth bypass state for tests
let authDisabled = false;
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

import { enforcePolicy, getPolicy } from "../route-policy.js";
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
    policyEpoch: 1,
  };
}

describe("enforcePolicy", () => {
  test("returns null for unregistered endpoints (no policy)", () => {
    authDisabled = false;
    const ctx = buildTestContext();
    const result = enforcePolicy("nonexistent/endpoint", ctx);
    expect(result).toBeNull();
  });

  test("returns null when actor context has required scopes and type", () => {
    authDisabled = false;
    const ctx = buildTestContext({ scopes: ["chat.read", "chat.write"] });
    const result = enforcePolicy("messages:POST", ctx);
    expect(result).toBeNull();
  });

  test("returns 403 when principal type is not allowed", () => {
    authDisabled = false;
    // channels/inbound requires svc_gateway, not actor
    const ctx = buildTestContext({
      principalType: "actor",
      scopes: ["ingress.write"],
    });
    const result = enforcePolicy("channels/inbound", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const _body = result!.json();
    // Response.json() returns a promise
  });

  test("returns 403 when required scope is missing", () => {
    authDisabled = false;
    // messages:POST requires chat.write, we only provide chat.read
    const ctx = buildTestContext({ scopes: ["chat.read"] });
    const result = enforcePolicy("messages:POST", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("channel inbound requires svc_gateway principal type", () => {
    authDisabled = false;
    const policy = getPolicy("channels/inbound");
    expect(policy).toBeDefined();
    expect(policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(policy!.requiredScopes).toContain("ingress.write");
  });

  test("channel inbound allows svc_gateway with ingress.write", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "svc_gateway",
      scopes: ["ingress.write", "internal.write"],
    });
    const result = enforcePolicy("channels/inbound", ctx);
    expect(result).toBeNull();
  });

  test("internal endpoints require svc_gateway principal type", () => {
    authDisabled = false;
    const policy = getPolicy("internal/twilio/voice-webhook");
    expect(policy).toBeDefined();
    expect(policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy!.allowedPrincipalTypes).not.toContain("actor");
    expect(policy!.requiredScopes).toContain("internal.write");
  });

  test("internal endpoints deny actor principal type", () => {
    authDisabled = false;
    const ctx = buildTestContext({
      principalType: "actor",
      scopes: ["internal.write"],
    });
    const result = enforcePolicy("internal/twilio/voice-webhook", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("standard actor endpoints allow actor, svc_gateway, and local", () => {
    authDisabled = false;
    const policy = getPolicy("messages:POST");
    expect(policy).toBeDefined();
    expect(policy!.allowedPrincipalTypes).toContain("actor");
    expect(policy!.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy!.allowedPrincipalTypes).toContain("local");
  });

  test("dev bypass allows all requests through regardless of policy", () => {
    authDisabled = true;
    // Actor trying to access channels/inbound (which requires svc_gateway)
    const ctx = buildTestContext({ principalType: "actor", scopes: [] });
    const result = enforcePolicy("channels/inbound", ctx);
    expect(result).toBeNull();
    authDisabled = false;
  });

  test("approval endpoints require approval.write scope", () => {
    authDisabled = false;
    const policy = getPolicy("confirm");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("approval.write");
  });

  test("guardian-actions/pending requires approval.read scope", () => {
    authDisabled = false;
    const policy = getPolicy("guardian-actions/pending");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("approval.read");
  });

  test("guardian-actions/decision requires approval.write scope", () => {
    authDisabled = false;
    const policy = getPolicy("guardian-actions/decision");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("approval.write");
  });

  test("conversation host-access write requires approval.write scope", () => {
    authDisabled = false;
    const policy = getPolicy("conversations/host-access");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("approval.write");
    expect(policy!.requiredScopes).not.toContain("chat.write");
  });

  test("events endpoint requires chat.read scope", () => {
    authDisabled = false;
    const policy = getPolicy("events");
    expect(policy).toBeDefined();
    expect(policy!.requiredScopes).toContain("chat.read");
  });
});
