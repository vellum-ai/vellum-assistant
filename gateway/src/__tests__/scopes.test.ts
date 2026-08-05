import { describe, expect, test } from "bun:test";

import { resolveScopeProfile } from "../auth/scopes.js";

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
