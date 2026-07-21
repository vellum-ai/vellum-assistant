/**
 * Unit tests for `enforceIngressAcl` consuming the gateway trust verdict.
 *
 * Drives the stage directly with a `sourceMetadata.trustVerdict` and mocks the
 * leaf I/O (contact store, gateway delivery, guardian notification) so the
 * ACL decision logic is exercised in isolation.
 *
 * Covers: verdict-sourced member resolution, fail-closed deny on an ABSENT
 * verdict, hard-denies for blocked/revoked/policy, and the stranger deny lane
 * firing for a present stranger verdict.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SourceMetadata, TrustVerdict } from "@vellumai/gateway-client";

import { createGatewayVerificationSessionsStub } from "../../../__tests__/helpers/gateway-verification-sessions-stub.js";

// Track contact-store reads to prove findContactChannel is NOT used on the
// verdict path.
const findContactChannelCalls: unknown[] = [];
mock.module("../../../contacts/contact-store.js", () => ({
  findContactChannel: (params: unknown) => {
    findContactChannelCalls.push(params);
    return null;
  },
}));

// Deny copy reads the guardian name from the stamped verdict; this tracker
// proves no per-deny guardian-delivery IPC fires.
const guardianDeliveryCalls: unknown[] = [];
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => {
    guardianDeliveryCalls.push({});
    return [];
  },
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
let accessRequestDeniedForTest = false;
let approvalHandshakeForTest = false;
mock.module("../../access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: (params: unknown) => {
    accessRequestCalls.push(params);
    return { notified: true };
  },
  isAccessRequestDenied: () => accessRequestDeniedForTest,
  isApprovalHandshakeInProgress: () => approvalHandshakeForTest,
}));

// Gateway-backed verification-session client: track challenge minting so the
// callback exemption (LUM-2673) can assert no session is created for button
// presses; the throw toggle simulates an unreachable gateway (transport
// errors surface as thrown errors from the client). Verification-read IPC
// calls (getPendingSession/findActiveSession) are recorded because the
// verdict's session-presence stamp must skip these when present-and-false.
const gatewaySessions = createGatewayVerificationSessionsStub({
  mintResult: () => ({
    sessionId: "session-1",
    secret: "123456",
    challengeHash: "hash",
    expiresAt: Date.now() + 600_000,
    ttlSeconds: 600,
  }),
});
mock.module(
  "../../../channels/gateway-verification-sessions.js",
  () => gatewaySessions.module,
);

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
    isCallbackInteraction: false,
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
  gatewaySessions.reset();
  findContactChannelCalls.length = 0;
  deliverReplyCalls.length = 0;
  accessRequestCalls.length = 0;
  accessRequestDeniedForTest = false;
  approvalHandshakeForTest = false;
  guardianDeliveryCalls.length = 0;
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

  test("member-less guardian verdict fails safe: denied with no stranger-lane side effects", async () => {
    // ATL-958 regression: the gateway proves guardian identity via a
    // same-channel member row, so every guardian verdict carries one. A
    // guardian verdict with NO member row is contradictory (e.g. a forged
    // cross-channel classification) and must not be admitted — but it must
    // not be routed through the stranger lane either, which would fire an
    // access request carrying the claimed guardian identity.
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "guardian",
          canonicalSenderId: "sender-1",
          guardianPrincipalId: "p-1",
        }),
      }),
    );

    expect(result.earlyResponse).toMatchObject({
      accepted: true,
      denied: true,
      reason: "not_a_member",
    });
    expect(result.resolvedMember).toBeNull();
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(0);
    expect(gatewaySessions.calls.create.length).toBe(0);
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

  test("guardian verdict with an explicit policy-deny member row is denied, not admitted", async () => {
    // An explicit per-channel policy deny on the guardian's own row is
    // honored like blocked/revoked — the guardian short-circuit must not
    // bypass it. Accurate policy_deny reason, no stranger-lane side effects.
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(
          memberVerdict({
            trustClass: "guardian",
            policy: "deny",
            guardianPrincipalId: "p-1",
          }),
        ),
      }),
    );

    expect(result.earlyResponse).toMatchObject({
      accepted: true,
      denied: true,
      reason: "policy_deny",
    });
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
          // Deliberately out-of-contract wire data (version skew / malformed
          // payload) — the cast is the point of the test.
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

describe("enforceIngressAcl — present stranger verdict enters the stranger lane", () => {
  test("present unknown/no-member verdict is denied via the stranger lane, not fail-closed", async () => {
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

    expect(result.earlyResponse).toMatchObject({
      accepted: true,
      denied: true,
      reason: "not_a_member",
    });
    expect(result.resolvedMember).toBeNull();
    // Stranger-lane side effects fire (unlike a fail-closed deny): the
    // guardian is notified and a canned reply is delivered.
    expect(accessRequestCalls.length).toBe(1);
    expect(deliverReplyCalls.length).toBe(1);
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
  test("resolutionFailed verdict → not_a_member deny with no stranger-lane side effects", async () => {
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
    // Distinct from a stranger: no onboarding or guardian notification fires.
    expect(deliverReplyCalls.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
    expect(findContactChannelCalls.length).toBe(0);
  });

  test("real unknown stranger (no resolutionFailed) still enters the stranger lane", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "sender-1",
        }),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.resolvedMember).toBeNull();
    // Stranger-lane side effects fire, unlike the resolutionFailed deny.
    expect(accessRequestCalls.length).toBe(1);
    expect(deliverReplyCalls.length).toBe(1);
  });
});

describe("enforceIngressAcl — deny copy names the guardian from the verdict", () => {
  test("non-member deny reply uses the verdict's guardianDisplayName with zero guardian-delivery reads", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
          guardianDisplayName: "Alice Guardian",
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
    expect(guardianDeliveryCalls.length).toBe(0);
  });

  test("absent guardianDisplayName degrades to the default reference", async () => {
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
    expect((denyReply!.payload as { text: string }).text).toContain("my human");
    expect(guardianDeliveryCalls.length).toBe(0);
  });

  test("Slack verification DM uses the verdict's guardianDisplayName", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
          guardianDisplayName: "Alice Guardian",
        }),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    const dm = deliverReplyCalls.find((c) =>
      String((c.payload as { text?: string }).text ?? "").includes(
        "don't recognize you yet",
      ),
    );
    expect(dm).toBeDefined();
    expect((dm!.payload as { text: string }).text).toContain("Alice Guardian");
    expect(guardianDeliveryCalls.length).toBe(0);
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

describe("enforceIngressAcl — a terminal deny suppresses re-prompting, not admission", () => {
  // Per the Slack-permissions PRD, admission is pure rank-vs-floor: a
  // guardian-denied sender is persisted as an unverified contact (rank 2) and is
  // admitted on exactly the same terms as any other unverified contact. The deny
  // only stops the guardian from being re-prompted; holding a contact out of
  // every floor is the (separate) block action's job. These matched pairs pin
  // that the denied flag does NOT change the admission outcome.
  test("any_contact: a terminally-denied unverified member is still admitted by the floor", async () => {
    accessRequestDeniedForTest = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ status: "unverified" })),
        effectiveAdmissionPolicy: "any_contact",
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).not.toBeNull();
    expect(result.resolvedMember!.status).toBe("unverified");
  });

  test("any_contact: a non-denied unverified member is admitted identically", async () => {
    accessRequestDeniedForTest = false;

    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ status: "unverified" })),
        effectiveAdmissionPolicy: "any_contact",
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).not.toBeNull();
    expect(result.resolvedMember!.status).toBe("unverified");
  });

  test("strangers: a terminally-denied non-member is still bypassed to the floor", async () => {
    accessRequestDeniedForTest = true;

    const result = await enforceIngressAcl(
      makeParams({
        canonicalSenderId: "stranger-1",
        rawSenderId: "stranger-1",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).toBeNull();
  });

  test("strangers: a non-denied stranger is bypassed identically", async () => {
    accessRequestDeniedForTest = false;

    const result = await enforceIngressAcl(
      makeParams({
        canonicalSenderId: "stranger-1",
        rawSenderId: "stranger-1",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
        effectiveAdmissionPolicy: "strangers",
      }),
    );

    expect(result.earlyResponse).toBeUndefined();
    expect(result.resolvedMember).toBeNull();
  });

  test("trusted_contacts: a denied unverified member is denied by the floor, not re-admitted", async () => {
    // Under a strict floor (rank 3) an unverified contact (rank 2) does not clear
    // the floor and is denied — same as any unverified contact, denied or not.
    // The floor governs exclusion here; the deny governs only re-prompting.
    accessRequestDeniedForTest = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceMetadata: withVerdict(memberVerdict({ status: "unverified" })),
        effectiveAdmissionPolicy: "trusted_contacts",
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.denied).toBe(true);
    // `unverified` maps to `pending` at the API-facing member layer.
    expect(result.earlyResponse!.reason).toBe("member_pending");
  });
});

describe("enforceIngressAcl — callback interactions never spawn stranger-lane side effects (LUM-2673)", () => {
  test("a stranger callback is denied without creating an access request", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        canonicalSenderId: "stranger-1",
        rawSenderId: "stranger-1",
        trimmedContent: "apr:req-1:approve_once",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
        isCallbackInteraction: true,
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(accessRequestCalls.length).toBe(0);
    expect(gatewaySessions.calls.create.length).toBe(0);
    // The deny reply still goes out so the click isn't a silent no-op.
    expect(deliverReplyCalls.length).toBe(1);
  });

  test("a Slack stranger callback initiates no verification challenge", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        trimmedContent: "apr:req-1:approve_once",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
        }),
        isCallbackInteraction: true,
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
  });

  test("a Slack unverified-member callback initiates no challenge and no access request", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123MEMBER",
        rawSenderId: "U123MEMBER",
        trimmedContent: "apr:req-1:approve_once",
        sourceMetadata: withVerdict(
          memberVerdict({
            status: "unverified",
            canonicalSenderId: "U123MEMBER",
            address: "U123MEMBER",
            type: "slack",
          }),
        ),
        isCallbackInteraction: true,
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("member_pending");
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(accessRequestCalls.length).toBe(0);
  });

  test("a callback inside the approval handshake window gets next-step copy, not a denial", async () => {
    approvalHandshakeForTest = true;

    const result = await enforceIngressAcl(
      makeParams({
        canonicalSenderId: "stranger-1",
        rawSenderId: "stranger-1",
        trimmedContent: "apr:req-1:approve_once",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
        isCallbackInteraction: true,
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(accessRequestCalls.length).toBe(0);
    expect(deliverReplyCalls.length).toBe(1);
    const payload = deliverReplyCalls[0].payload as { text: string };
    expect(payload.text).toContain("approved");
    expect(payload.text).toContain("verification code");
  });

  test("a Slack stranger MESSAGE still gets the challenge + access request (control)", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
        }),
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(accessRequestCalls.length).toBe(1);
  });

  test("a Slack bot never receives the self-verify challenge — guardian is notified directly", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123BOT",
        rawSenderId: "U123BOT",
        sourceMetadata: {
          ...withVerdict({
            trustClass: "unknown",
            canonicalSenderId: "U123BOT",
          }),
          isBot: true,
        } as SourceMetadata,
      }),
    );

    expect(result.earlyResponse).toBeDefined();
    // No verification session is minted — a bot cannot return a code.
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(accessRequestCalls.length).toBe(1);
  });

  test("an active session for the same sender suppresses a duplicate challenge", async () => {
    gatewaySessions.state.activeSession = {
      id: "existing-session",
      channel: "slack",
      status: "awaiting_response",
      expectedExternalUserId: "U123STRANGER",
    };

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
        }),
      }),
    );

    // Dedup: no new session, fall through to the standard deny.
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.create.length).toBe(0);
  });

  test("an active session for a DIFFERENT sender does not suppress the challenge", async () => {
    gatewaySessions.state.activeSession = {
      id: "existing-session",
      channel: "slack",
      status: "awaiting_response",
      expectedExternalUserId: "U_SOMEONE_ELSE",
    };

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
        }),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
  });

  test("identity signals from sourceMetadata are forwarded to the access request", async () => {
    await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123BOT",
        rawSenderId: "U123BOT",
        sourceMetadata: {
          ...withVerdict({
            trustClass: "unknown",
            canonicalSenderId: "U123BOT",
          }),
          isBot: true,
          isStranger: true,
          isRestricted: true,
        } as SourceMetadata,
      }),
    );

    expect(accessRequestCalls.length).toBe(1);
    const call = accessRequestCalls[0] as {
      isBot?: boolean;
      isStranger?: boolean;
      isRestricted?: boolean;
    };
    expect(call.isBot).toBe(true);
    expect(call.isStranger).toBe(true);
    expect(call.isRestricted).toBe(true);
  });
});

describe("enforceIngressAcl — bootstrap deep-link bypass reads via the gateway", () => {
  function bootstrapParams(
    overrides: Partial<AclEnforcementParams> = {},
  ): AclEnforcementParams {
    return makeParams({
      canonicalSenderId: "stranger-1",
      rawSenderId: "stranger-1",
      trimmedContent: "/start gv_token123",
      sourceMetadata: {
        ...withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger-1",
        }),
        commandIntent: { type: "start", payload: "gv_token123" },
      } as SourceMetadata,
      ...overrides,
    });
  }

  test("a valid pending_bootstrap session bypasses the non-member deny", async () => {
    gatewaySessions.state.bootstrapSession = {
      id: "bootstrap-session",
      channel: "telegram",
      status: "pending_bootstrap",
    };

    const result = await enforceIngressAcl(bootstrapParams());

    expect(result.earlyResponse).toBeUndefined();
    expect(result.validatedBootstrapSession).toMatchObject({
      id: "bootstrap-session",
      status: "pending_bootstrap",
    });
  });

  test("an unresolvable token keeps the deny", async () => {
    gatewaySessions.state.bootstrapSession = null;

    const result = await enforceIngressAcl(bootstrapParams());

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.validatedBootstrapSession).toBeUndefined();
  });

  test("gateway unreachable degrades to the plain deny — no throw, no bypass", async () => {
    gatewaySessions.unreachable.all = true;

    const result = await enforceIngressAcl(bootstrapParams());

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(result.validatedBootstrapSession).toBeUndefined();
    expect(gatewaySessions.calls.create.length).toBe(0);
  });
});

describe("enforceIngressAcl — gateway-unreachable deny branches degrade to a plain deny", () => {
  test("Slack stranger message: session reads throwing skips the challenge, normal deny fires", async () => {
    gatewaySessions.unreachable.all = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "U123STRANGER",
        }),
      }),
    );

    // No challenge minted, no throw: the standard deny lane still runs
    // (guardian notified, canned reply delivered).
    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(accessRequestCalls.length).toBe(1);
    expect(deliverReplyCalls.length).toBe(1);
  });

  test("Slack inactive member: session reads throwing skips the re-verify challenge", async () => {
    gatewaySessions.unreachable.all = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123MEMBER",
        rawSenderId: "U123MEMBER",
        sourceMetadata: withVerdict(
          memberVerdict({
            status: "unverified",
            canonicalSenderId: "U123MEMBER",
            address: "U123MEMBER",
            type: "slack",
          }),
        ),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("member_pending");
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(accessRequestCalls.length).toBe(1);
  });

  test("email stranger message: session reads throwing skips the challenge", async () => {
    gatewaySessions.unreachable.all = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "email",
        canonicalSenderId: "stranger@example.com",
        rawSenderId: "stranger@example.com",
        sourceMetadata: withVerdict({
          trustClass: "unknown",
          canonicalSenderId: "stranger@example.com",
        }),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.create.length).toBe(0);
  });
});

describe("enforceIngressAcl — verdict session-presence stamp elides the verification-read IPC pair", () => {
  function strangerVerdict(
    stamp: boolean | undefined,
    senderId = "U123STRANGER",
  ): TrustVerdict {
    return {
      trustClass: "unknown",
      canonicalSenderId: senderId,
      ...(stamp !== undefined && {
        hasInterceptableVerificationSession: stamp,
      }),
    };
  }

  test("stamp false (Slack stranger): challenge minted with ZERO verification-read IPC calls", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict(strangerVerdict(false)),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(gatewaySessions.calls.sessionReads.length).toBe(0);
  });

  test("stamp false (email stranger): challenge minted with ZERO verification-read IPC calls", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "email",
        canonicalSenderId: "stranger@example.com",
        rawSenderId: "stranger@example.com",
        sourceMetadata: withVerdict(
          strangerVerdict(false, "stranger@example.com"),
        ),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(gatewaySessions.calls.sessionReads.length).toBe(0);
  });

  test("stamp false (Slack inactive member): re-verify challenge minted with ZERO verification-read IPC calls", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123MEMBER",
        rawSenderId: "U123MEMBER",
        sourceMetadata: withVerdict(
          memberVerdict({
            status: "unverified",
            canonicalSenderId: "U123MEMBER",
            address: "U123MEMBER",
            type: "slack",
            hasInterceptableVerificationSession: false,
          }),
        ),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(gatewaySessions.calls.sessionReads.length).toBe(0);
  });

  test("stamp true: falls back to the IPC reads — same-sender session still dedups", async () => {
    // The stamp is channel-scoped; only `false` is authoritative. A `true`
    // stamp must preserve the sender-scoped dedup via the reads.
    gatewaySessions.state.activeSession = {
      id: "existing-session",
      channel: "slack",
      status: "awaiting_response",
      expectedExternalUserId: "U123STRANGER",
    };

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict(strangerVerdict(true)),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.create.length).toBe(0);
    expect(gatewaySessions.calls.sessionReads.length).toBe(2);
  });

  test("stamp true: a DIFFERENT sender's session does not suppress the challenge", async () => {
    gatewaySessions.state.activeSession = {
      id: "existing-session",
      channel: "slack",
      status: "awaiting_response",
      expectedExternalUserId: "U_SOMEONE_ELSE",
    };

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict(strangerVerdict(true)),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(gatewaySessions.calls.sessionReads.length).toBe(2);
  });

  test("absent stamp (legacy/voice-relay verdict): falls back to the IPC reads", async () => {
    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict(strangerVerdict(undefined)),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("verification_challenge_sent");
    expect(gatewaySessions.calls.create.length).toBe(1);
    expect(gatewaySessions.calls.sessionReads.length).toBe(2);
  });

  test("stamp false with the gateway unreachable at mint time degrades to a plain deny", async () => {
    gatewaySessions.unreachable.all = true;

    const result = await enforceIngressAcl(
      makeParams({
        sourceChannel: "slack",
        canonicalSenderId: "U123STRANGER",
        rawSenderId: "U123STRANGER",
        sourceMetadata: withVerdict(strangerVerdict(false)),
      }),
    );

    expect(result.earlyResponse!.reason).toBe("not_a_member");
    expect(gatewaySessions.calls.sessionReads.length).toBe(0);
  });
});
