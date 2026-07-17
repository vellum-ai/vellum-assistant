/**
 * Security regression test for the personal-memory trust gate under
 * DISABLE_HTTP_AUTH.
 *
 * `isPersonalMemoryAllowed` derives trust from `resolveTrustClass`, which only
 * elevates an *unresolved* actor to guardian under DISABLE_HTTP_AUTH (the
 * standing config in platform-managed deployments). A resolved non-guardian
 * channel actor must therefore be denied personal memory even with auth
 * disabled — otherwise the guardian's memory leaks to Slack/phone contacts in
 * the cloud. See LUM-2669. These cases fail on the pre-fix behavior.
 *
 * Uses process.env directly (not a module mock) since isHttpAuthDisabled()
 * reads DISABLE_HTTP_AUTH live.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isPersonalMemoryAllowed } from "../daemon/trust-context.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";

function slack(trustClass: TrustClass): TrustContext {
  return { sourceChannel: "slack", trustClass };
}

let prior: string | undefined;

beforeEach(() => {
  // Platform-managed / dev-bypass posture: the flag is on process-wide.
  prior = process.env.DISABLE_HTTP_AUTH;
  process.env.DISABLE_HTTP_AUTH = "true";
});

afterEach(() => {
  if (prior === undefined) {
    delete process.env.DISABLE_HTTP_AUTH;
  } else {
    process.env.DISABLE_HTTP_AUTH = prior;
  }
});

describe("isPersonalMemoryAllowed — no exposure to non-guardian channel actors under DISABLE_HTTP_AUTH", () => {
  test("blocks personal memory for a non-guardian Slack actor even with auth disabled", () => {
    expect(isPersonalMemoryAllowed(slack("trusted_contact"))).toBe(false);
    expect(isPersonalMemoryAllowed(slack("unknown"))).toBe(false);
    expect(isPersonalMemoryAllowed(slack("unverified_contact"))).toBe(false);
  });

  test("allows personal memory for the guardian and for local / internal turns", () => {
    expect(isPersonalMemoryAllowed(slack("guardian"))).toBe(true);
    // Local/native turn — no resolved actor.
    expect(isPersonalMemoryAllowed(undefined)).toBe(true);
    // Internal vellum-channel flow.
    expect(
      isPersonalMemoryAllowed({
        sourceChannel: "vellum",
        trustClass: "unknown",
      }),
    ).toBe(true);
  });
});
