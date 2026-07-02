/**
 * Unit tests for `resolveMidCallTrustContext` — the mid-setup trust
 * re-resolution used after verification/activation on a phone call.
 *
 * The gateway verdict is authoritative right after the gateway updated the
 * binding, but the resolver must fall back to local resolution when the
 * verdict is missing, failed, member-claiming-but-unusable, or a memberless
 * unknown (a just-activated invitee the gateway can't see yet). Memberful
 * unknown verdicts (blocked/revoked members) are honored so their deny ACL
 * is enforced.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";

const FROM_NUMBER = "+15555550100";

// ── Module mocks ─────────────────────────────────────────────────────

// Verdict returned by the mocked gateway reader; null exercises the
// missing-verdict fallback.
let mockVerdict: TrustVerdict | null = null;

const realInboundTrustReader = {
  ...(await import("../calls/inbound-trust-reader.js")),
};
mock.module("../calls/inbound-trust-reader.js", () => ({
  ...realInboundTrustReader,
  getInboundTrustVerdict: async () => mockVerdict,
  getPhoneCallerVerdict: async () => mockVerdict,
}));

// Records fallback-path cache warms.
let guardianDeliveryFreshCalls: Array<{ channelTypes?: string[] }> = [];
const realGuardianDeliveryReader = {
  ...(await import("../contacts/guardian-delivery-reader.js")),
};
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  ...realGuardianDeliveryReader,
  getGuardianDeliveryFresh: async (input?: { channelTypes?: string[] }) => {
    guardianDeliveryFreshCalls.push(input ?? {});
    return [];
  },
}));

// Local resolver stub: records calls and returns a distinctive
// trusted_contact context so tests can tell the local path produced the
// result. `toTrustContext` stays real.
let localResolutions: Array<{ actorExternalId?: string }> = [];
const LOCAL_ACTOR_TRUST: ActorTrustContext = {
  canonicalSenderId: FROM_NUMBER,
  guardianBindingMatch: null,
  memberRecord: null,
  trustClass: "trusted_contact",
  actorMetadata: {
    identifier: FROM_NUMBER,
    displayName: "Local Alice",
    senderDisplayName: undefined,
    memberDisplayName: undefined,
    username: undefined,
    channel: "phone",
    trustStatus: "trusted_contact",
  },
};
const realActorTrustResolver = {
  ...(await import("../runtime/actor-trust-resolver.js")),
};
mock.module("../runtime/actor-trust-resolver.js", () => ({
  ...realActorTrustResolver,
  resolveActorTrust: (input: { actorExternalId?: string }) => {
    localResolutions.push(input);
    return LOCAL_ACTOR_TRUST;
  },
}));

// Spy on the verdict mapper so tests can assert whether the verdict path
// (rather than the local fallback) produced the final context.
let trustVerdictMapperUsed = false;
const realTrustVerdictConsumer = {
  ...(await import("../runtime/trust-verdict-consumer.js")),
};
mock.module("../runtime/trust-verdict-consumer.js", () => ({
  ...realTrustVerdictConsumer,
  trustContextFromVerdict: (
    ...args: Parameters<typeof realTrustVerdictConsumer.trustContextFromVerdict>
  ) => {
    trustVerdictMapperUsed = true;
    return realTrustVerdictConsumer.trustContextFromVerdict(...args);
  },
}));

const { resolveMidCallTrustContext } =
  await import("../calls/call-setup-flow.js");

beforeEach(() => {
  mockVerdict = null;
  guardianDeliveryFreshCalls = [];
  localResolutions = [];
  trustVerdictMapperUsed = false;
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

    expect(trustVerdictMapperUsed).toBe(true);
    expect(localResolutions.length).toBe(0);
    expect(context.sourceChannel).toBe("phone");
    expect(context.trustClass).toBe("guardian");
    expect(context.guardianExternalUserId).toBe(FROM_NUMBER);
  });

  test("missing verdict (gateway blip) falls back to local resolution", async () => {
    mockVerdict = null;

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(trustVerdictMapperUsed).toBe(false);
    expect(localResolutions).toEqual([
      expect.objectContaining({ actorExternalId: FROM_NUMBER }),
    ]);
    expect(context.trustClass).toBe("trusted_contact");
  });

  test("resolutionFailed verdict falls back to local resolution without dropping the call", async () => {
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: null,
      resolutionFailed: true,
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(trustVerdictMapperUsed).toBe(false);
    expect(localResolutions.length).toBe(1);
    expect(context.trustClass).toBe("trusted_contact");
  });

  test("member-claiming but unusable verdict falls back to local resolution", async () => {
    // Claims a member (contactId/channelId) but the ACL can't be reassembled
    // (missing status/policy) — the unusable condition.
    mockVerdict = {
      trustClass: "trusted_contact",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_unusable",
      channelId: "ch_unusable",
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(trustVerdictMapperUsed).toBe(false);
    expect(localResolutions.length).toBe(1);
    expect(context.trustClass).toBe("trusted_contact");
  });

  test("memberless unknown verdict falls back to local resolution (just-activated invitee not downgraded)", async () => {
    // Invite redemption writes the channel assistant-side, so right after
    // activation the gateway has no member and returns a memberless unknown
    // verdict. That is a stale gateway view — local resolution has the fresh
    // channel, so the invitee must not be downgraded to unknown.
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: FROM_NUMBER,
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(trustVerdictMapperUsed).toBe(false);
    expect(localResolutions.length).toBe(1);
    expect(context.trustClass).toBe("trusted_contact");
  });

  test("fallback warms the phone guardian-delivery cache before the sync local resolve", async () => {
    mockVerdict = null;

    await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(guardianDeliveryFreshCalls).toEqual([{ channelTypes: ["phone"] }]);
  });

  test("memberful blocked unknown verdict is honored (verdict path enforces blocked status)", async () => {
    // The gateway classifies a blocked member as trustClass "unknown" but
    // still carries contactId/channelId and the deny ACL. This memberful
    // unknown must take the verdict path so its blocked status is enforced —
    // not fall back to local, which could miss a stale block.
    mockVerdict = {
      trustClass: "unknown",
      canonicalSenderId: FROM_NUMBER,
      contactId: "ct_blocked",
      channelId: "ch_blocked",
      status: "blocked",
      policy: "deny",
    };

    const context = await resolveMidCallTrustContext("self", FROM_NUMBER);

    expect(trustVerdictMapperUsed).toBe(true);
    expect(localResolutions.length).toBe(0);
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

    expect(trustVerdictMapperUsed).toBe(true);
    expect(localResolutions.length).toBe(0);
    expect(context.memberStatus).toBe("revoked");
    expect(context.memberPolicy).toBe("deny");
  });
});
