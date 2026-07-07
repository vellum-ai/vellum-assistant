/**
 * Unit tests for `resolveMidCallTrustContext` — the mid-setup trust
 * re-resolution used after verification/activation on a phone call.
 *
 * The gateway verdict is the sole trust source: a usable verdict (including
 * memberless unknown and memberful blocked/revoked) is consumed directly; a
 * missing/failed/member-unresolvable verdict throws, and the flow's caller
 * keeps the setup-time trust. Local `resolveActorTrust` is never consulted.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

const FROM_NUMBER = "+15555550100";

// ── Module mocks ─────────────────────────────────────────────────────

// Verdict returned by the mocked gateway reader; null exercises the
// missing-verdict path.
let mockVerdict: TrustVerdict | null = null;

const realInboundTrustReader = {
  ...(await import("../calls/inbound-trust-reader.js")),
};
mock.module("../calls/inbound-trust-reader.js", () => ({
  ...realInboundTrustReader,
  getInboundTrustVerdict: async () => mockVerdict,
  getPhoneCallerVerdict: async () => mockVerdict,
}));

// Records any (forbidden) fallback-path cache warms.
let guardianDeliveryFreshCalls = 0;
const realGuardianDeliveryReader = {
  ...(await import("../contacts/guardian-delivery-reader.js")),
};
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  ...realGuardianDeliveryReader,
  getGuardianDeliveryFresh: async () => {
    guardianDeliveryFreshCalls += 1;
    return [];
  },
}));

// Local resolver stub: `resolveActorTrust` must never be consulted mid-call.
let localResolutions = 0;
const realActorTrustResolver = {
  ...(await import("../runtime/actor-trust-resolver.js")),
};
mock.module("../runtime/actor-trust-resolver.js", () => ({
  ...realActorTrustResolver,
  resolveActorTrust: () => {
    localResolutions += 1;
    throw new Error("resolveMidCallTrustContext must not call resolveActorTrust");
  },
}));

const { resolveMidCallTrustContext } =
  await import("../calls/call-setup-flow.js");

beforeEach(() => {
  mockVerdict = null;
  guardianDeliveryFreshCalls = 0;
  localResolutions = 0;
});

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveMidCallTrustContext", () => {
  test("usable guardian verdict re-resolves trust from the gateway verdict", async () => {
    mockVerdict = {
      trustClass: "guardian",
      canonicalSenderId: FROM_NUMBER,
      guardianExternalUserId: FROM_NUMBER,
      guardianPrincipalId: FROM_NUMBER,
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(localResolutions).toBe(0);
    expect(context.sourceChannel).toBe("phone");
    expect(context.trustClass).toBe("guardian");
    expect(context.guardianExternalUserId).toBe(FROM_NUMBER);
  });

  test("usable trusted-contact member verdict is consumed directly", async () => {
    mockVerdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_1",
      channelId: "ch_1",
      status: "active",
      policy: "allow",
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(localResolutions).toBe(0);
    expect(context.trustClass).toBe("trusted_contact");
    expect(context.memberStatus).toBe("active");
  });

  test("missing verdict throws (caller keeps setup-time trust) with no local fallback", async () => {
    mockVerdict = null;

    await expect(
      resolveMidCallTrustContext("self", FROM_NUMBER),
    ).rejects.toThrow(/verdict unavailable/);
    expect(localResolutions).toBe(0);
    expect(guardianDeliveryFreshCalls).toBe(0);
  });

  test("resolutionFailed verdict throws with no local fallback", async () => {
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: null,
      resolutionFailed: true,
    };

    await expect(
      resolveMidCallTrustContext("self", FROM_NUMBER),
    ).rejects.toThrow(/verdict unavailable/);
    expect(localResolutions).toBe(0);
    expect(guardianDeliveryFreshCalls).toBe(0);
  });

  test("member-claiming but unresolvable verdict throws with no local fallback", async () => {
    // Claims a member (contactId/channelId) but the ACL can't be reassembled
    // (missing status/policy) — the unusable condition.
    mockVerdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_unusable",
      channelId: "ch_unusable",
    };

    await expect(
      resolveMidCallTrustContext("self", FROM_NUMBER),
    ).rejects.toThrow(/verdict unavailable/);
    expect(localResolutions).toBe(0);
  });

  test("memberless unknown verdict is consumed as unknown (gateway is authoritative)", async () => {
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: FROM_NUMBER,
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(localResolutions).toBe(0);
    expect(context.trustClass).toBe("unknown");
  });

  test("memberful blocked unknown verdict is honored (verdict path enforces blocked status)", async () => {
    // The gateway classifies a blocked member as trustClass "unknown" but
    // still carries contactId/channelId and the deny ACL. This memberful
    // unknown takes the verdict path so its blocked status is enforced.
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_blocked",
      channelId: "ch_blocked",
      status: "blocked",
      policy: "deny",
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(localResolutions).toBe(0);
    expect(context.memberStatus).toBe("blocked");
    expect(context.memberPolicy).toBe("deny");
  });

  test("memberful revoked unknown verdict is honored (verdict path enforces revoked status)", async () => {
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_revoked",
      channelId: "ch_revoked",
      status: "revoked",
      policy: "deny",
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(localResolutions).toBe(0);
    expect(context.memberStatus).toBe("revoked");
    expect(context.memberPolicy).toBe("deny");
  });
});
