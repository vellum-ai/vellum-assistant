/**
 * Reaction-intercept trust classification from the gateway-stamped verdict.
 *
 * The intercept reads the reactor's trust solely from
 * `sourceMetadata.trustVerdict` (via `actorTrustContextFromVerdict`) — no
 * local resolver, cache warm, or IPC reads. Pins the four dispositions:
 * guardian reactions route into the approval decision pipeline, contact
 * reactions are recorded but never approve, and unknown / missing / failed /
 * contradictory verdicts drop fail-closed before any write.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

const GUARDIAN_USER_ID = "U_GUARDIAN_VERDICT";
const MEMBER_USER_ID = "U_MEMBER_VERDICT";
const SLACK_CHANNEL_ID = "C0VERDICT";

// ---------------------------------------------------------------------------
// Choreography spies: the intercept must make ZERO gateway IPC reads,
// guardian-delivery reads, or member-verdict cache writes.
// ---------------------------------------------------------------------------

let ipcCalls: string[] = [];
mock.module("../../../ipc/gateway-client.js", () => ({
  ipcCall: async (route: string) => {
    ipcCalls.push(route);
    return {};
  },
}));

let guardianDeliveryReads = 0;
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => {
    guardianDeliveryReads++;
    return [];
  },
  getGuardianDeliveryFresh: async () => {
    guardianDeliveryReads++;
    return [];
  },
  peekCachedGuardianDelivery: () => {
    guardianDeliveryReads++;
    return undefined;
  },
  guardianForChannel: () => undefined,
  anyGuardian: () => undefined,
}));

let setMemberVerdictCalls = 0;
mock.module("../../member-verdict-cache.js", () => ({
  setMemberVerdict: () => {
    setMemberVerdictCalls++;
  },
  getCachedMemberAcl: () => undefined,
  __resetMemberVerdictCacheForTest: () => {},
}));

// Local contact store must not be consulted — verdict-only classification.
let contactLookups = 0;
mock.module("../../../contacts/contact-store.js", () => ({
  findContactByAddress: () => {
    contactLookups++;
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Downstream side-effect stubs
// ---------------------------------------------------------------------------

let recordInboundCalls = 0;
mock.module("../../../persistence/delivery-crud.js", () => ({
  recordInbound: () => {
    recordInboundCalls++;
    return {
      eventId: "evt-1",
      conversationId: "conv-1",
      accepted: true,
      duplicate: false,
    };
  },
  clearPayload: () => {},
  linkMessage: () => {},
}));

let addMessageCalls = 0;
mock.module("../../../persistence/conversation-crud.js", () => ({
  addMessage: async () => {
    addMessageCalls++;
    return { id: "msg-1" };
  },
}));

mock.module("../../../persistence/delivery-status.js", () => ({
  markProcessed: () => {},
}));
mock.module("../../../persistence/external-conversation-store.js", () => ({
  upsertBinding: () => {},
}));
mock.module("../../../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => ({ level: "ok" }),
}));
mock.module("../../../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: () => ({ action: "allow" }),
}));

let guardianReplyCalls: Array<{
  trustClass: string;
  guardianPrincipalId: string | null | undefined;
}> = [];
let guardianReplyResponse: Record<string, unknown> | undefined;
mock.module("./guardian-reply-intercept.js", () => ({
  handleGuardianReplyIntercept: async (params: {
    trustClass: string;
    guardianPrincipalId: string | null | undefined;
  }) => {
    guardianReplyCalls.push({
      trustClass: params.trustClass,
      guardianPrincipalId: params.guardianPrincipalId,
    });
    return { response: guardianReplyResponse };
  },
}));

import { handleSlackReactionIntercept } from "./reaction-intercept.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUARDIAN_VERDICT: TrustVerdict = {
  trustClass: "guardian",
  canonicalSenderId: GUARDIAN_USER_ID,
  contactId: "guardian-contact",
  channelId: "guardian-channel",
  type: "slack",
  address: GUARDIAN_USER_ID,
  status: "active",
  policy: "allow",
  guardianExternalUserId: GUARDIAN_USER_ID,
  guardianDeliveryChatId: SLACK_CHANNEL_ID,
  guardianPrincipalId: "principal-guardian-1",
};

const MEMBER_VERDICT: TrustVerdict = {
  trustClass: "trusted_contact",
  canonicalSenderId: MEMBER_USER_ID,
  contactId: "member-contact",
  channelId: "member-channel",
  type: "slack",
  address: MEMBER_USER_ID,
  status: "active",
  policy: "allow",
};

const UNKNOWN_VERDICT: TrustVerdict = {
  trustClass: "unknown",
  canonicalSenderId: "U_STRANGER",
};

let msgCounter = 0;

function buildParams(overrides: {
  rawSenderId: string;
  trustVerdict?: TrustVerdict;
}) {
  msgCounter++;
  return {
    callbackData: "reaction:white_check_mark",
    sourceChannel: "slack" as const,
    sourceInterface: "slack" as const,
    conversationExternalId: SLACK_CHANNEL_ID,
    externalMessageId: `${SLACK_CHANNEL_ID}:1700000000.1:${msgCounter}`,
    canonicalAssistantId: "assistant-1",
    rawSenderId: overrides.rawSenderId,
    canonicalSenderId: overrides.rawSenderId,
    actorDisplayName: "Reactor",
    actorUsername: undefined,
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: {
      messageId: "1700000000.1",
      chatType: "channel",
      ...(overrides.trustVerdict
        ? { trustVerdict: overrides.trustVerdict }
        : {}),
    } as never,
    slackChannelName: "general",
    approvalConversationGenerator: undefined,
  };
}

function expectDropped(result: Record<string, unknown>): void {
  expect(result.reaction).toBe("dropped_unknown_actor");
  // Dropped before any write or routing: no dedup record, no transcript row,
  // no approval-pipeline dispatch.
  expect(recordInboundCalls).toBe(0);
  expect(addMessageCalls).toBe(0);
  expect(guardianReplyCalls.length).toBe(0);
}

describe("reaction intercept consumes the stamped verdict directly", () => {
  beforeEach(() => {
    ipcCalls = [];
    guardianDeliveryReads = 0;
    setMemberVerdictCalls = 0;
    contactLookups = 0;
    recordInboundCalls = 0;
    addMessageCalls = 0;
    guardianReplyCalls = [];
    guardianReplyResponse = undefined;
  });

  test("guardian verdict routes the reaction into the approval decision pipeline", async () => {
    guardianReplyResponse = { accepted: true, canonicalRouter: "applied" };

    const result = await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
      }),
    );

    expect(guardianReplyCalls).toEqual([
      { trustClass: "guardian", guardianPrincipalId: "principal-guardian-1" },
    ]);
    // Consumed as a guardian decision — short-circuits before persistence.
    expect(result).toEqual(guardianReplyResponse);
    expect(addMessageCalls).toBe(0);
  });

  test("contact verdict records the reaction; the decision pipeline self-gate ignores it", async () => {
    const result = await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    // Dispatched with the contact class (guardian-reply-intercept self-gates
    // on guardian), then falls through to transcript persistence.
    expect(guardianReplyCalls).toEqual([
      { trustClass: "trusted_contact", guardianPrincipalId: undefined },
    ]);
    expect(result.accepted).toBe(true);
    expect(result.reaction).toBeUndefined();
    expect(addMessageCalls).toBe(1);
  });

  test("unknown verdict is dropped before any write", async () => {
    const result = await handleSlackReactionIntercept(
      buildParams({ rawSenderId: "U_STRANGER", trustVerdict: UNKNOWN_VERDICT }),
    );
    expectDropped(result);
  });

  test("missing verdict is dropped fail-closed", async () => {
    const result = await handleSlackReactionIntercept(
      buildParams({ rawSenderId: MEMBER_USER_ID }),
    );
    expectDropped(result);
  });

  test("resolutionFailed verdict is dropped fail-closed even with a guardian shape", async () => {
    const result = await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: { ...GUARDIAN_VERDICT, resolutionFailed: true },
      }),
    );
    expectDropped(result);
  });

  test("memberless guardian verdict is contradictory and dropped fail-closed", async () => {
    const result = await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: {
          trustClass: "guardian",
          canonicalSenderId: GUARDIAN_USER_ID,
          guardianPrincipalId: "principal-guardian-1",
        },
      }),
    );
    expectDropped(result);
  });

  test("classification is verdict-only: no IPC, cache, or local-store reads", async () => {
    guardianReplyResponse = { accepted: true, canonicalRouter: "applied" };
    await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
      }),
    );
    await handleSlackReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(ipcCalls).toEqual([]);
    expect(guardianDeliveryReads).toBe(0);
    expect(setMemberVerdictCalls).toBe(0);
    expect(contactLookups).toBe(0);
  });
});
