import { describe, expect, test } from "bun:test";

import { isNarrowScopeProfile, resolveScopeProfile } from "../auth/scopes.js";
import type { ScopeProfile } from "../auth/types.js";

describe("resolveScopeProfile", () => {
  test("known profiles resolve to their scopes", () => {
    expect(resolveScopeProfile("speech_relay_v1").has("speech.relay")).toBe(
      true,
    );
    expect(resolveScopeProfile("speech_relay_v1").size).toBe(1);
    expect(
      resolveScopeProfile("gateway_service_v1").has("settings.write"),
    ).toBe(true);
  });

  test("oauth_proxy_v1 grants oauth.proxy and nothing else", () => {
    expect([...resolveScopeProfile("oauth_proxy_v1")]).toEqual(["oauth.proxy"]);
  });

  test("no other profile grants oauth.proxy", () => {
    // Keyed by Exclude<...> so a new profile fails typecheck until listed.
    const others: Record<Exclude<ScopeProfile, "oauth_proxy_v1">, true> = {
      actor_client_v1: true,
      gateway_ingress_v1: true,
      gateway_service_v1: true,
      local_v1: true,
      speech_relay_v1: true,
      ui_page_v1: true,
    };
    for (const profile of Object.keys(others) as ScopeProfile[]) {
      expect(resolveScopeProfile(profile).has("oauth.proxy")).toBe(false);
    }
  });

  test("unknown profiles resolve to no scopes, including prototype keys", () => {
    // Claims come from JSON, so the ScopeProfile type does not protect at
    // runtime. Unknown names and Object.prototype keys must both fail closed
    // rather than throwing in validateScopedEdgeBearer.
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
