/**
 * Cold-cache guardian-reaction regression.
 *
 * The sync trust resolver reads the IO-free guardian-delivery cache snapshot
 * (`peekCachedGuardianDelivery`). On a cold process only `vellum` is warmed at
 * daemon startup, so for `slack` the snapshot is empty until some read warms
 * that exact channel key. `handleSlackReactionIntercept` therefore awaits
 * `getGuardianDelivery({ channelTypes: ["slack"] })` BEFORE the sync resolve so
 * a guardian's approval reaction classifies as `guardian` rather than dropping
 * as `unknown`.
 *
 * This test drives the REAL guardian-delivery reader cache (mocking only the
 * gateway `ipcCall`) so the cold→warm transition is exercised end to end.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const GUARDIAN_USER_ID = "U_GUARDIAN_COLD";
const SLACK_CHANNEL_ID = "C0COLD";

// Gateway IPC stub: returns the slack guardian delivery. The real reader caches
// the result under the `slack` key, so a subsequent sync `peek` finds it.
let ipcCalls: Array<{ route: string; input: unknown }> = [];
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (route: string, input: unknown) => {
    ipcCalls.push({ route, input });
    return {
      guardians: [
        {
          channelType: "slack",
          contactId: "guardian-contact",
          principalId: GUARDIAN_USER_ID,
          address: GUARDIAN_USER_ID,
          externalChatId: SLACK_CHANNEL_ID,
          status: "active",
        },
      ],
    };
  },
}));

// Contact lookup is irrelevant to guardian classification (address match on the
// cached delivery decides it); return null so member lookup is a no-op.
mock.module("../contacts/contact-store.js", () => ({
  findContactByAddress: () => null,
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

// Capture the trustClass the guardian decision pipeline receives — this is the
// classification produced by the sync resolve after the upstream warm.
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

import {
  __resetGuardianDeliveryCacheForTest,
  peekCachedGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { handleSlackReactionIntercept } from "../runtime/routes/inbound-stages/reaction-intercept.js";

function buildParams() {
  return {
    callbackData: "reaction:white_check_mark",
    sourceChannel: "slack" as const,
    sourceInterface: "slack" as const,
    conversationExternalId: SLACK_CHANNEL_ID,
    externalMessageId: `${SLACK_CHANNEL_ID}:1700000000.1:cold`,
    canonicalAssistantId: "assistant-1",
    rawSenderId: GUARDIAN_USER_ID,
    canonicalSenderId: GUARDIAN_USER_ID,
    actorDisplayName: "Guardian",
    actorUsername: undefined,
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: { messageId: "1700000000.1", chatType: "channel" } as never,
    slackChannelName: "general",
    approvalConversationGenerator: undefined,
  };
}

describe("reaction intercept warms the channel guardian cache before sync trust", () => {
  beforeEach(() => {
    __resetGuardianDeliveryCacheForTest();
    ipcCalls = [];
    receivedTrustClass = undefined;
  });

  test("cold slack cache: guardian reaction classifies as guardian after upstream warm", async () => {
    // Precondition: cold cache for slack — the sync peek would miss.
    expect(
      peekCachedGuardianDelivery({ channelTypes: ["slack"] }),
    ).toBeUndefined();

    await handleSlackReactionIntercept(buildParams());

    // The intercept warmed the slack-specific key via the async reader.
    expect(
      ipcCalls.some(
        (c) =>
          c.route === "resolve_guardian_delivery" &&
          JSON.stringify(c.input) ===
            JSON.stringify({ channelTypes: ["slack"] }),
      ),
    ).toBe(true);

    // The sync resolve, reading the now-warm snapshot, classified the reactor as
    // the guardian — not dropped as `unknown`.
    expect(receivedTrustClass).toBe("guardian");
  });
});
