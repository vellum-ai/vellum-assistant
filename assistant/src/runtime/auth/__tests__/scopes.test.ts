import { describe, expect, test } from "bun:test";

import { hasAllScopes, hasScope, resolveScopeProfile } from "../scopes.js";
import type { AuthContext, Scope, ScopeProfile } from "../types.js";

/** Utility to create a minimal AuthContext with a given scope profile. */
function makeCtx(profile: ScopeProfile): AuthContext {
  return {
    subject: "test:self:id",
    principalType: "actor",
    assistantId: "self",
    scopeProfile: profile,
    scopes: resolveScopeProfile(profile),
    policyEpoch: 1,
  };
}

describe("resolveScopeProfile", () => {
  test("actor_client_v1 includes all client scopes", () => {
    const scopes = resolveScopeProfile("actor_client_v1");
    const expected: Scope[] = [
      "chat.read",
      "chat.write",
      "approval.read",
      "approval.write",
      "settings.read",
      "settings.write",
      "attachments.read",
      "attachments.write",
      "calls.read",
      "calls.write",
      "feature_flags.read",
      "feature_flags.write",
    ];
    for (const s of expected) {
      expect(scopes.has(s)).toBe(true);
    }
    expect(scopes.size).toBe(expected.length);
  });

  test("actor_client_v1 does not include server-only scopes", () => {
    const scopes = resolveScopeProfile("actor_client_v1");
    expect(scopes.has("ingress.write")).toBe(false);
    expect(scopes.has("internal.write")).toBe(false);
    expect(scopes.has("local.all")).toBe(false);
  });

  test("gateway_ingress_v1 includes ingress and internal scopes", () => {
    const scopes = resolveScopeProfile("gateway_ingress_v1");
    expect(scopes.has("ingress.write")).toBe(true);
    expect(scopes.has("internal.write")).toBe(true);
    expect(scopes.size).toBe(2);
  });

  test("gateway_service_v1 includes chat, settings, attachments, and internal scopes", () => {
    const scopes = resolveScopeProfile("gateway_service_v1");
    expect(scopes.has("chat.read")).toBe(true);
    expect(scopes.has("chat.write")).toBe(true);
    expect(scopes.has("settings.read")).toBe(true);
    expect(scopes.has("settings.write")).toBe(true);
    expect(scopes.has("attachments.read")).toBe(true);
    expect(scopes.has("attachments.write")).toBe(true);
    expect(scopes.has("internal.write")).toBe(true);
    expect(scopes.size).toBe(7);
  });

  test("local_v1 includes only local.all", () => {
    const scopes = resolveScopeProfile("local_v1");
    expect(scopes.has("local.all")).toBe(true);
    expect(scopes.size).toBe(1);
  });
});

describe("hasScope", () => {
  test("returns true for a scope the profile includes", () => {
    const ctx = makeCtx("actor_client_v1");
    expect(hasScope(ctx, "chat.read")).toBe(true);
  });

  test("returns false for a scope the profile excludes", () => {
    const ctx = makeCtx("actor_client_v1");
    expect(hasScope(ctx, "ingress.write")).toBe(false);
  });

  test("returns true for local.all on local_v1 profile", () => {
    const ctx = makeCtx("local_v1");
    expect(hasScope(ctx, "local.all")).toBe(true);
  });
});

describe("hasAllScopes", () => {
  test("returns true when all requested scopes are present", () => {
    const ctx = makeCtx("actor_client_v1");
    expect(hasAllScopes(ctx, "chat.read", "chat.write", "approval.read")).toBe(
      true,
    );
  });

  test("returns false when any requested scope is missing", () => {
    const ctx = makeCtx("actor_client_v1");
    expect(hasAllScopes(ctx, "chat.read", "ingress.write")).toBe(false);
  });

  test("returns true for empty scope list", () => {
    const ctx = makeCtx("actor_client_v1");
    expect(hasAllScopes(ctx)).toBe(true);
  });

  test("returns true for single present scope", () => {
    const ctx = makeCtx("gateway_ingress_v1");
    expect(hasAllScopes(ctx, "ingress.write")).toBe(true);
  });

  test("returns false for single absent scope", () => {
    const ctx = makeCtx("gateway_ingress_v1");
    expect(hasAllScopes(ctx, "chat.read")).toBe(false);
  });
});
