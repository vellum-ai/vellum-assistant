import { describe, expect, test } from "bun:test";

import {
  hasAllScopes,
  hasScope,
  isNarrowScopeProfile,
  resolveScopeProfile,
} from "../scopes.js";
import type { AuthContext, Scope, ScopeProfile } from "../types.js";

/** Every profile name; the Record keeps this list exhaustive. */
const KNOWN_PROFILES = Object.keys({
  actor_client_v1: true,
  gateway_ingress_v1: true,
  gateway_service_v1: true,
  local_v1: true,
  oauth_proxy_v1: true,
  speech_relay_v1: true,
  ui_page_v1: true,
} satisfies Record<ScopeProfile, true>) as ScopeProfile[];

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

  test("speech_relay_v1 includes only speech.relay (ATL-1033 least-privilege)", () => {
    const scopes = resolveScopeProfile("speech_relay_v1");
    expect(scopes.has("speech.relay")).toBe(true);
    expect(scopes.size).toBe(1);
  });

  test("unknown profiles resolve to no scopes, including prototype keys", () => {
    // Claims come from JSON, so the ScopeProfile type does not protect at
    // runtime. Unknown names and Object.prototype keys must both fail closed.
    for (const profile of [
      "bogus_v1",
      "toString",
      "constructor",
      "__proto__",
    ]) {
      const scopes = resolveScopeProfile(profile as never);
      expect(scopes.size).toBe(0);
    }
  });

  test("local_v1 includes only local.all", () => {
    const scopes = resolveScopeProfile("local_v1");
    expect(scopes.has("local.all")).toBe(true);
    expect(scopes.size).toBe(1);
  });

  test("oauth_proxy_v1 includes only oauth.proxy", () => {
    const scopes = resolveScopeProfile("oauth_proxy_v1");
    expect(scopes.has("oauth.proxy")).toBe(true);
    expect(scopes.size).toBe(1);
  });

  test("no other profile grants oauth.proxy", () => {
    for (const profile of KNOWN_PROFILES) {
      if (profile === "oauth_proxy_v1") {
        continue;
      }
      expect(resolveScopeProfile(profile).has("oauth.proxy")).toBe(false);
    }
  });
});

describe("isNarrowScopeProfile", () => {
  test("classifies every profile", () => {
    // The source table is exhaustive over ScopeProfile, so a new profile has
    // to be classified there. This pins the answers it gives today: a `true`
    // flipped onto a single-route grant would open every unscoped route to it.
    const narrow: Record<ScopeProfile, boolean> = {
      actor_client_v1: false,
      gateway_ingress_v1: false,
      gateway_service_v1: false,
      local_v1: false,
      oauth_proxy_v1: true,
      speech_relay_v1: true,
      ui_page_v1: false,
    };
    for (const [profile, expected] of Object.entries(narrow)) {
      expect(isNarrowScopeProfile(profile as ScopeProfile)).toBe(expected);
    }
  });

  test("unknown profiles and prototype keys are narrow", () => {
    // Claims come from JSON, so an unrecognized profile reaches this despite
    // the type, and a prototype key resolves to an object rather than `true`.
    for (const profile of [
      "bogus_v1",
      "toString",
      "constructor",
      "__proto__",
    ]) {
      expect(isNarrowScopeProfile(profile as never)).toBe(true);
    }
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
