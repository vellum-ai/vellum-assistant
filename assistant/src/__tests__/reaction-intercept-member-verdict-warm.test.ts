/**
 * Cold-cache member-reaction regression.
 *
 * Slack reactions carry the gateway-stamped verdict on `sourceMetadata` but
 * skip `getInboundTrustVerdict`, which is what warms the member-verdict cache
 * the sync trust resolver reads. `handleSlackReactionIntercept` therefore seeds
 * the cache from the stamped verdict before the sync resolve, so an active
 * non-guardian contact's reaction classifies as `trusted_contact` instead of
 * failing closed to `unknown` (and being dropped) on a cold process.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const MEMBER_USER_ID = "U_MEMBER_COLD";
const MEMBER_CONTACT_ID = "member-contact";
const MEMBER_CHANNEL_ID = "member-channel";
const SLACK_CHANNEL_ID = "C0MEMBERCOLD";

const MEMBER_CONTACT = {
  id: MEMBER_CONTACT_ID,
  displayName: "Member",
  notes: null,
  lastInteraction: null,
  interactionCount: 0,
  createdAt: 0,
  updatedAt: 0,
  contactType: "human",
  userFile: null,
  channels: [
    {
      id: MEMBER_CHANNEL_ID,
      contactId: MEMBER_CONTACT_ID,
      type: "slack",
      address: MEMBER_USER_ID,
      isPrimary: false,
      externalChatId: SLACK_CHANNEL_ID,
      lastSeenAt: null,
      interactionCount: 0,
      lastInteraction: null,
      updatedAt: null,
      createdAt: 0,
    },
  ],
};

// No guardian for slack — the reactor is a member, not the guardian.
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async () => ({ guardians: [] }),
}));

// The reactor resolves to a local member channel by address.
mock.module("../contacts/contact-store.js", () => ({
  findContactByAddress: (_channelType: string, address: string) =>
    address === MEMBER_USER_ID ? MEMBER_CONTACT : null,
}));

// Stub downstream side effects so the test isolates trust classification.
mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "msg-1" }),
}));
mock.module("../persistence/delivery-crud.js", () => ({
  recordInbound: () => ({
    eventId: "evt-1",
    conversationId: "conv-1",
    accepted: true,
    duplicate: false,
  }),
  clearPayload: () => {},
  linkMessage: () => {},
}));
mock.module("../persistence/delivery-status.js", () => ({
  markProcessed: () => {},
}));
mock.module("../persistence/external-conversation-store.js", () => ({
  upsertBinding: () => {},
}));
mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => ({ level: "ok" }),
}));
mock.module("../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: () => ({ action: "allow" }),
}));

let receivedTrustClass: string | undefined;
mock.module(
  "../runtime/routes/inbound-stages/guardian-reply-intercept.js",
  () => ({
    handleGuardianReplyIntercept: async (params: { trustClass: string }) => {
      receivedTrustClass = params.trustClass;
      return { response: { accepted: true, canonicalRouter: "applied" } };
    },
  }),
);

import { __resetMemberVerdictCacheForTest } from "../runtime/member-verdict-cache.js";
import { handleSlackReactionIntercept } from "../runtime/routes/inbound-stages/reaction-intercept.js";

function buildParams(withStampedVerdict: boolean) {
  return {
    callbackData: "reaction:white_check_mark",
    sourceChannel: "slack" as const,
    sourceInterface: "slack" as const,
    conversationExternalId: SLACK_CHANNEL_ID,
    externalMessageId: `${SLACK_CHANNEL_ID}:1700000000.2:cold`,
    canonicalAssistantId: "assistant-1",
    rawSenderId: MEMBER_USER_ID,
    canonicalSenderId: MEMBER_USER_ID,
    actorDisplayName: "Member",
    actorUsername: undefined,
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: {
      messageId: "1700000000.2",
      chatType: "channel",
      ...(withStampedVerdict
        ? {
            trustVerdict: {
              trustClass: "trusted_contact",
              canonicalSenderId: MEMBER_USER_ID,
              contactId: MEMBER_CONTACT_ID,
              channelId: MEMBER_CHANNEL_ID,
              type: "slack",
              address: MEMBER_USER_ID,
              status: "active",
              policy: "allow",
            },
          }
        : {}),
    } as never,
    slackChannelName: "general",
    approvalConversationGenerator: undefined,
  };
}

describe("reaction intercept seeds the member-verdict cache from the stamped verdict", () => {
  beforeEach(() => {
    __resetMemberVerdictCacheForTest();
    receivedTrustClass = undefined;
  });

  test("cold cache + stamped verdict: active member reaction classifies as trusted_contact", async () => {
    const result = await handleSlackReactionIntercept(buildParams(true));

    // Not dropped — the stamped verdict warmed the cache, so the sync resolve
    // found the member as active.
    expect(result.reaction).not.toBe("dropped_unknown_actor");
    expect(receivedTrustClass).toBe("trusted_contact");
  });

  test("cold cache + no stamped verdict: same member reaction fails closed to unknown", async () => {
    const result = await handleSlackReactionIntercept(buildParams(false));

    // Negative control: with no stamped verdict and a cold cache, the member
    // can't be classified, so the reaction is dropped — proving the warm above
    // is load-bearing.
    expect(result.reaction).toBe("dropped_unknown_actor");
    expect(receivedTrustClass).toBeUndefined();
  });
});
