import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────

let fakeHttpAuthDisabled = false;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import {
  resolveTrustClass,
  type TrustContext,
} from "../daemon/trust-context.js";

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

  test("does not elevate a resolved non-guardian actor when HTTP auth is disabled", () => {
    // DISABLE_HTTP_AUTH is the standing config in platform-managed deployments,
    // so a resolved channel actor's class must survive it — otherwise a
    // non-guardian Slack/phone contact would be treated as the guardian
    // (LUM-2669). Only an unresolved (local/native) turn is elevated; see below.
    fakeHttpAuthDisabled = true;
    expect(
      resolveTrustClass({ trustClass: "trusted_contact" } as TrustContext),
    ).toBe("trusted_contact");
    expect(resolveTrustClass({ trustClass: "unknown" } as TrustContext)).toBe(
      "unknown",
    );
  });

  test("treats an unresolved (local/native) turn as guardian when HTTP auth is disabled", () => {
    // Local/native turns reach the daemon without a channel-resolved
    // trustContext; in an auth-disabled (local) deployment that actor is the
    // guardian, so control-plane gates don't block local development.
    fakeHttpAuthDisabled = true;
    expect(resolveTrustClass(undefined)).toBe("guardian");
  });
});
