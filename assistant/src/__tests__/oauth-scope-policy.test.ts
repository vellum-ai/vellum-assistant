import { describe, expect, it } from "bun:test";

import type { ScopeResolverInput } from "../oauth/scope-policy.js";
import { resolveScopes } from "../oauth/scope-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal scope resolver input for testing scope resolution. */
function makeProfile(
  overrides: Partial<ScopeResolverInput> = {},
): ScopeResolverInput {
  return {
    service: "test-service",
    defaultScopes: ["read", "write"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveScopes", () => {
  it("returns default scopes when no requestedScopes are provided", () => {
    const profile = makeProfile({ defaultScopes: ["read", "write"] });
    const result = resolveScopes(profile);
    expect(result).toEqual({ ok: true, scopes: ["read", "write"] });
  });

  it("returns default scopes when requestedScopes is undefined", () => {
    const profile = makeProfile({ defaultScopes: ["read", "write"] });
    const result = resolveScopes(profile, undefined);
    expect(result).toEqual({ ok: true, scopes: ["read", "write"] });
  });

  it("returns default scopes when requestedScopes is an empty array", () => {
    const profile = makeProfile({ defaultScopes: ["read", "write"] });
    const result = resolveScopes(profile, []);
    expect(result).toEqual({ ok: true, scopes: ["read", "write"] });
  });

  it("rejects a forbidden scope with a clear error message", () => {
    const profile = makeProfile({
      scopePolicy: {
        allowAdditionalScopes: true,
        allowedOptionalScopes: ["admin"],
        forbiddenScopes: ["delete"],
      },
    });
    const result = resolveScopes(profile, ["delete"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Scope 'delete' is forbidden for test-service");
    }
  });

  it("rejects additional scopes when allowAdditionalScopes is false", () => {
    const profile = makeProfile({
      defaultScopes: ["read", "write"],
      scopePolicy: {
        allowAdditionalScopes: false,
        allowedOptionalScopes: [],
        forbiddenScopes: [],
      },
    });
    const result = resolveScopes(profile, ["admin"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "Additional scopes are not allowed for test-service",
      );
      expect(result.allowedScopes).toEqual(["read", "write"]);
    }
  });

  it("rejects a scope not in allowedOptionalScopes even when allowAdditionalScopes is true", () => {
    const profile = makeProfile({
      defaultScopes: ["read"],
      scopePolicy: {
        allowAdditionalScopes: true,
        allowedOptionalScopes: ["write"],
        forbiddenScopes: [],
      },
    });
    const result = resolveScopes(profile, ["admin"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "Scope 'admin' is not in the allowed optional scopes for test-service",
      );
      expect(result.allowedScopes).toEqual(["read", "write"]);
    }
  });

  it("accepts an additional scope when it is in allowedOptionalScopes and allowAdditionalScopes is true", () => {
    const profile = makeProfile({
      defaultScopes: ["read"],
      scopePolicy: {
        allowAdditionalScopes: true,
        allowedOptionalScopes: ["write", "admin"],
        forbiddenScopes: [],
      },
    });
    const result = resolveScopes(profile, ["write"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(["read", "write"]);
    }
  });

  it("deduplicates scopes in the result", () => {
    const profile = makeProfile({
      defaultScopes: ["read", "write"],
      scopePolicy: {
        allowAdditionalScopes: true,
        allowedOptionalScopes: ["admin"],
        forbiddenScopes: [],
      },
    });
    // Request duplicates of existing defaults and a new scope twice
    const result = resolveScopes(profile, ["read", "write", "admin", "admin"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(["read", "write", "admin"]);
    }
  });

  it("keeps requested scopes that are already in defaults without error", () => {
    const profile = makeProfile({
      defaultScopes: ["read", "write"],
      scopePolicy: {
        allowAdditionalScopes: false,
        allowedOptionalScopes: [],
        forbiddenScopes: [],
      },
    });
    // Requesting only default scopes should succeed even when
    // allowAdditionalScopes is false
    const result = resolveScopes(profile, ["read", "write"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(["read", "write"]);
    }
  });

  it("checks forbidden scopes before allowAdditionalScopes policy", () => {
    const profile = makeProfile({
      defaultScopes: ["read"],
      scopePolicy: {
        allowAdditionalScopes: true,
        allowedOptionalScopes: [],
        forbiddenScopes: ["destroy"],
      },
    });
    const result = resolveScopes(profile, ["destroy"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should be the forbidden error, not the "not in optional scopes" error
      expect(result.error).toContain("forbidden");
    }
  });

  it("returns a defensive copy of defaultScopes (not the same array reference)", () => {
    const defaults = ["read", "write"];
    const profile = makeProfile({ defaultScopes: defaults });
    const result = resolveScopes(profile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(defaults);
      expect(result.scopes).not.toBe(defaults);
    }
  });
});
