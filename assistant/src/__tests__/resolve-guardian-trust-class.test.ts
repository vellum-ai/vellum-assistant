import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../daemon/session-runtime-assembly.js";

// ── Module mocks ─────────────────────────────────────────────────────

let fakeHttpAuthDisabled = false;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import { resolveGuardianTrustClass } from "../daemon/session-tool-setup.js";

afterAll(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveGuardianTrustClass", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
  });

  test("returns guardian context trust class when auth is enabled", () => {
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "trusted_contact",
    };
    expect(resolveGuardianTrustClass(ctx as TrustContext)).toBe(
      "trusted_contact",
    );
  });

  test("returns 'unknown' when guardianContext is undefined", () => {
    expect(resolveGuardianTrustClass(undefined)).toBe("unknown");
  });

  test("forces guardian when HTTP auth is disabled, regardless of context trust class", () => {
    fakeHttpAuthDisabled = true;
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "trusted_contact",
    };
    expect(resolveGuardianTrustClass(ctx as TrustContext)).toBe(
      "guardian",
    );
  });

  test("forces guardian for unknown trust class when HTTP auth is disabled", () => {
    fakeHttpAuthDisabled = true;
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "unknown",
    };
    expect(resolveGuardianTrustClass(ctx as TrustContext)).toBe(
      "guardian",
    );
  });
});
