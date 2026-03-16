import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";

// ── Module mocks ─────────────────────────────────────────────────────

let fakeHttpAuthDisabled = false;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import { resolveTrustClass } from "../daemon/conversation-tool-setup.js";

afterAll(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveTrustClass", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
  });

  test("returns guardian context trust class when auth is enabled", () => {
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "trusted_contact",
    };
    expect(resolveTrustClass(ctx as TrustContext)).toBe("trusted_contact");
  });

  test("returns 'unknown' when trustContext is undefined", () => {
    expect(resolveTrustClass(undefined)).toBe("unknown");
  });

  test("forces guardian when HTTP auth is disabled, regardless of context trust class", () => {
    fakeHttpAuthDisabled = true;
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "trusted_contact",
    };
    expect(resolveTrustClass(ctx as TrustContext)).toBe("guardian");
  });

  test("forces guardian for unknown trust class when HTTP auth is disabled", () => {
    fakeHttpAuthDisabled = true;
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "unknown",
    };
    expect(resolveTrustClass(ctx as TrustContext)).toBe("guardian");
  });
});
