/**
 * Unit tests for `enforceIngressAcl` consuming the gateway trust verdict.
 *
 * Drives the stage directly with a `sourceMetadata.trustVerdict` and mocks the
 * leaf I/O (contact store, gateway delivery, guardian notification, invite
 * transport) so the ACL decision logic is exercised in isolation.
 *
 * Covers: verdict-sourced member resolution, fail-closed deny on an ABSENT
 * verdict, hard-denies for blocked/revoked/policy, and the non-member invite
 * intercept still firing for a present stranger verdict.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SourceMetadata, TrustVerdict } from "@vellumai/gateway-client";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Track contact-store reads to prove findContactChannel is NOT used on the
// verdict path.
const findContactChannelCalls: unknown[] = [];
mock.module("../../../contacts/contact-store.js", () => ({
  findContactChannel: (params: unknown) => {
    findContactChannelCalls.push(params);
    return null;
  },
}));

// resolveGuardianLabel resolves the guardian via the gateway delivery reader.
let guardianDeliveryList: Array<Record<string, unknown>> = [];
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => guardianDeliveryList,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

mock.module("../../../prompts/user-reference.js", () => ({
  resolveGuardianName: (displayName?: string | null) =>
    displayName && displayName.trim().length > 0
      ? displayName.trim()
      : "my human",
}));

const deliverReplyCalls: Array<{ url: string; payload: unknown }> = [];
mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: async (url: string, payload: unknown) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

const accessRequestCalls: unknown[] = [];
mock.module("../../access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: (params: unknown) => {
    accessRequestCalls.push(params);
    return { notified: true };
  },
}));

// Invite transport: by default no adapter (no token). Per-test override below.
let inviteTokenForTest: string | undefined;
mock.module("../../channel-invite-transport.js", () => ({
  getInviteAdapterRegistry: () => ({
    get: () => ({
      extractInboundToken: () => inviteTokenForTest,
    }),
  }),
}));

// Invite redemption: default to a successful redeem so the token intercept
// short-circuits with an earlyResponse.
mock.module("../../invite-redemption-service.js", () => ({
  redeemInvite: async () => ({ ok: true, type: "redeemed", memberId: "m-1" }),
  redeemInviteByCode: async () => ({
    ok: true,
    type: "redeemed",
    memberId: "m-1",
  }),
}));

mock.module("../../invite-redemption-templates.js", () => ({
  getInviteRedemptionReply: () => "redeemed reply",
}));

mock.module("../../../persistence/delivery-crud.js", () => ({
  recordInbound: () => ({ duplicate: false, eventId: "evt-1" }),
  deleteInbound: () => {},
}));

mock.module("../../../persistence/delivery-status.js", () => ({
  markProcessed: () => {},
}));

import type { AclEnforcementParams } from "./acl-enforcement.js";
import { enforceIngressAcl } from "./acl-enforcement.js";

function makeParams(
  overrides: Partial<AclEnforcementParams> = {},
): AclEnforcementParams {
  return {
    canonicalSenderId: "sender-1",
    hasSenderIdentityClaim: true,
    rawSenderId: "sender-1",
    sourceChannel: "telegram",
    conversationExternalId: "chat-1",
    canonicalAssistantId: "assistant-1",
    trimmedContent: "hello",
    sourceMetadata: undefined,
    actorDisplayName: "Sender One",
    actorUsername: "sender_one",
    replyCallbackUrl: "http://localhost/deliver",
    assistantId: "assistant-1",
    externalMessageId: "msg-1",
    ...overrides,
  };
}

function memberVerdict(overrides: Partial<TrustVerdict> = {}): TrustVerdict {
  return {
    trustClass: "trusted_contact",
    canonicalSenderId: "sender-1",
    contactId: "contact-1",
    channelId: "channel-1",
    type: "telegram",
    address: "sender-1",
    status: "active",
    policy: "allow",
    memberDisplayName: "Sender One",
    ...overrides,
  };
}

function withVerdict(verdict: TrustVerdict): SourceMetadata {
  return { trustVerdict: verdict } as SourceMetadata;
}

beforeEach(() => {
  findContactChannelCalls.length = 0;
  deliverReplyCalls.length = 0;
  accessRequestCalls.length = 0;
  inviteTokenForTest = undefined;
  guardianDeliveryList = [];
});

afterEach(() => {
  inviteTokenForTest = undefined;
});

describe("enforceIngressAcl — verdict-sourced member resolution", () => {
  test("active trusted verdict is admitted (resolvedMember threaded, no deny)", async () => {
    const result = await enforceIngressAcl(
      makeParams({ sourceMetadata: withVerdict(memberVerdict()) }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).not.toBeNull();
    expect(result.resolvedMember!.status).toBe("active");
    expect(result.resolvedMember!.policy).toBe("allow");
    // Member came from the verdict, never the local contact store.
    expect(findContactChannelCalls.length).toBe(0);
  });

  test("guardian verdict is admitted purely from the verdict (empty contact store)", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({ trustClass: "guardian", guardianPrincipalId: "p-1" }),
        ),
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).not.toBeNull();
    expect(result.resolvedMember!.status).toBe("active");
    expect(findContactChannelCalls.length).toBe(0);
  });

  test("member-less guardian verdict is admitted and never fires an access request", async () => {
    // A guardian classified by principal reaches this channel with NO
    // per-channel member row: trustClass is "guardian" but the verdict
    // carries no contactId/channelId/status/policy. The guardian
    // short-circuit must admit them instead of routing them into the
    // stranger branch, which fires notifyGuardianOfAccessRequest at the
    // guardian themselves.
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "guardian",
          canonicalSenderId: "sender-1",
          guardianPrincipalId: "p-1",
        }),
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).toBeNull();
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(0);
  });

  test("guardian verdict with an inactive (pending) member row is still admitted", async () => {
    // Guardian by principal whose same-channel row is pending: the
    // inactive-member deny gate must not challenge or deny the guardian.
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({
            trustClass: "guardian",
            status: "pending",
            guardianPrincipalId: "p-1",
          }),
        ),
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).not.toBeNull();
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(0);
  });

  test("contradictory guardian verdict with a blocked member row fails safe", async () => {
    // The gateway never classifies a blocked row as guardian; a verdict
    // claiming both is malformed. Soft-deny with no stranger-lane side
    // effects.
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({
            trustClass: "guardian",
            status: "blocked",
            policy: "deny",
          }),
        ),
      }),
    );

    expect(result.earlyResponse).toMatchObject({
      accepted: true,
      denied: true,
      reason: "not_a_member",
    });
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(0);
  });

  test("unrecognized trust class fails safe: denied with no stranger-lane side effects", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "totally_new_class" as TrustVerdict["trustClass"],
          canonicalSenderId: "sender-1",
        }),
      }),
    );

    expect(result.earlyResponse).toMatchObject({
      accepted: true,
      denied: true,
      reason: "not_a_member",
    });
    // Fail-safe, never fail-stranger: no access-request card, no
    // verification challenge, no canned reply.
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(0);
  });
});

describe("enforceIngressAcl — hard denies from the verdict status/policy", () => {
  test("blocked verdict → member_blocked deny", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ status: "blocked" })),
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("member_blocked");
    // Blocked members do not trigger a guardian notification.
    expect(accessRequestCalls.length).toBe(0);
  });

  test("revoked verdict → member_revoked deny (even under strangers)", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ status: "revoked" })),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse!.reason).toBe("member_revoked");
  });

  test("policy deny verdict → policy_deny", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ policy: "deny" })),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("policy_deny");
  });
});

describe("enforceIngressAcl — present stranger verdict flows through intercepts", () => {
  test("present unknown/no-member verdict + invite token redeems via intercept", async () => {
    inviteTokenForTest = "iv_token123";
    const strangerVerdict: TrustVerdict = {
      trustClass: "unknown",
      canonicalSenderId: "stranger-1",
    };

    const result = await enforceIngressAcl(
      makeParams({
        canonicalSenderId: "stranger-1",
        rawSenderId: "stranger-1",
        sourceMetadata: withVerdict(strangerVerdict),
      }),
    );

    // The invite token intercept fired — NOT a fail-closed deny.
    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.inviteRedemption).toBe("redeemed");
    expect(result.resolvedMember).toBeNull();
  });
});

describe("enforceIngressAcl — fail-closed on absent verdict", () => {
  test("absent trustVerdict → not_a_member deny even under strangers", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        // sourceMetadata present but WITHOUT trustVerdict.
        sourceMetadata: {} as SourceMetadata,
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
    // Fail-closed deny short-circuits BEFORE any intercept or onboarding.
    expect(deliverReplyCalls.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
    expect(findContactChannelCalls.length).toBe(0);
  });

  test("no sourceMetadata at all → not_a_member deny", async () => {
    const result = await enforceIngressAcl(
      makeParams({ sourceMetadata: undefined }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
  });
});

describe("enforceIngressAcl — fail-closed on resolutionFailed verdict", () => {
  test("resolutionFailed verdict → not_a_member deny, does not flow to intercepts", async () => {
    inviteTokenForTest = "iv_token123";
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "sender-1",
          resolutionFailed: true,
        }),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
    // Distinct from a stranger: no invite redemption, onboarding, or
    // guardian notification fires.
    expect(result.earlyResponse!.inviteRedemption).toBeUndefined();
    expect(deliverReplyCalls.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
    expect(findContactChannelCalls.length).toBe(0);
  });

  test("real unknown stranger (no resolutionFailed) still redeems via intercept", async () => {
    inviteTokenForTest = "iv_token123";
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "sender-1",
        }),
      }),
    );

    expect(result.earlyResponse!.inviteRedemption).toBe("redeemed");
    expect(result.resolvedMember).toBeNull();
  });
});

describe("enforceIngressAcl — deny copy names the gateway guardian", () => {
  test("non-member deny reply uses the guardian displayName from the gateway list", async () => {
    guardianDeliveryList = [
      {
        channelType: "vellum",
        contactId: "c-1",
        principalId: "p-anchor",
        displayName: "Alice Guardian",
        address: "p-anchor",
        status: "active",
      },
    ];

    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    const denyReply = deliverReplyCalls.find((c) =>
      String((c.payload as { text?: string }).text ?? "").includes(
        "tried talking to me",
      ),
    );
    expect(denyReply).toBeDefined();
    expect((denyReply!.payload as { text: string }).text).toContain(
      "Alice Guardian",
    );
  });
});

describe("enforceIngressAcl — fail-closed on malformed member verdict", () => {
  test("member identity + unknown policy → not_a_member deny even under strangers", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({ policy: "bogus" as TrustVerdict["policy"] }),
        ),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    // Carries contactId/channelId but no resolvable member → fail closed,
    // NOT admitted as a stranger by the floor.
    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
    expect(deliverReplyCalls.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
  });

  test("member identity + missing status → not_a_member deny even under strangers", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({
            status: undefined as unknown as TrustVerdict["status"],
          }),
        ),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
  });
});
