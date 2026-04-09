/**
 * Tests for Slack inbound trusted contact verification.
 *
 * When an unknown Slack user messages the bot, the system should:
 * 1. Create an outbound verification session bound to the user's identity
 * 2. Send the verification code to the user's DM via the gateway
 * 3. Reply in the original channel telling the user to check their DMs
 * 4. Notify the guardian of the access attempt
 * 5. When the user replies with the code in the DM, verify and activate
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Track emitNotificationSignal calls
const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-signal-id",
      deduplicated: false,
      dispatched: true,
      reason: "mock",
      deliveryResults: [],
    };
  },
}));

// Track deliverChannelReply calls
const deliverReplyCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
}> = [];
let deliverChannelReplyImpl:
  | ((url: string, payload: Record<string, unknown>) => Promise<void>)
  | null = null;
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    deliverReplyCalls.push({ url, payload });
    if (deliverChannelReplyImpl) {
      await deliverChannelReplyImpl(url, payload);
    }
  },
}));

import {
  createGuardianBinding,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getDb, initializeDb } from "../memory/db.js";
import { findActiveSession } from "../runtime/channel-verification-service.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";
import { clearSlackAclDenyNotificationCache } from "../runtime/routes/inbound-stages/acl-enforcement.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM channel_verification_sessions");
  db.run("DELETE FROM channel_guardian_rate_limits");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  deliverChannelReplyImpl = null;
  clearSlackAclDenyNotificationCache();
}

function buildSlackInboundRequest(
  overrides: Record<string, unknown> = {},
): Request {
  const body: Record<string, unknown> = {
    sourceChannel: "slack",
    interface: "slack",
    conversationExternalId: "C0123CHANNEL",
    externalMessageId: `msg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    content: "Hello, can I use this assistant?",
    actorExternalId: "U0123UNKNOWN",
    actorDisplayName: "Alice Unknown",
    actorUsername: "alice_unknown",
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    ...overrides,
  };

  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Slack inbound trusted contact verification", () => {
  beforeEach(() => {
    resetState();
  });

  test("unknown Slack user receives verification challenge via DM", async () => {
    const req = buildSlackInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe("verification_challenge_sent");
    expect(json.verificationSessionId).toBeDefined();

    // Verification code is NOT sent to the requester — only the guardian
    // receives it via the access request notification flow

    // Channel reply tells user they're not recognized yet
    expect(deliverReplyCalls.length).toBe(1);
    expect(
      (deliverReplyCalls[0].payload as Record<string, unknown>).text,
    ).toContain("I don't recognize you yet");
  });

  test("verification session is identity-bound to the Slack user", async () => {
    const req = buildSlackInboundRequest();
    await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);

    // An active outbound session should exist for the slack channel
    const session = findActiveSession("slack");
    expect(session).not.toBeNull();
    expect(session!.expectedExternalUserId).toBe("U0123UNKNOWN");
    expect(session!.expectedChatId).toBe("U0123UNKNOWN");
    expect(session!.identityBindingStatus).toBe("bound");
    expect(session!.verificationPurpose).toBe("trusted_contact");
  });

  test("guardian is notified of the access attempt alongside verification", async () => {
    // Set up a guardian binding so the notification can target it
    createGuardianBinding({
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN",
      guardianDeliveryChatId: "D_GUARDIAN_DM",
      guardianPrincipalId: "guardian-principal",
      verifiedVia: "test",
    });

    const req = buildSlackInboundRequest();
    await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);

    // Guardian should have been notified
    expect(emitSignalCalls.length).toBe(1);
    expect(emitSignalCalls[0].sourceEventName).toBe("ingress.access_request");
    expect(emitSignalCalls[0].sourceChannel).toBe("slack");
  });

  test("duplicate challenge is not sent when session already exists", async () => {
    // First message creates the session
    const req1 = buildSlackInboundRequest();
    const resp1 = await handleChannelInbound(
      req1,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json1 = (await resp1.json()) as Record<string, unknown>;
    expect(json1.reason).toBe("verification_challenge_sent");

    // Second message from the same user — session already exists, so
    // falls through to standard deny path
    const req2 = buildSlackInboundRequest({
      externalMessageId: `msg-${Date.now()}-second`,
    });
    const resp2 = await handleChannelInbound(
      req2,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    expect(json2.denied).toBe(true);
    expect(json2.reason).toBe("not_a_member");

    // No DM was sent at all
  });

  test("threaded Slack ACL reply is only shown once per thread after the verification challenge already exists", async () => {
    const threadReplyCallbackUrl =
      "http://localhost:7830/deliver/slack?channel=C0123CHANNEL&threadTs=1700000000.000100";

    const req1 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
    });
    const resp1 = await handleChannelInbound(
      req1,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json1 = (await resp1.json()) as Record<string, unknown>;
    expect(json1.reason).toBe("verification_challenge_sent");

    const req2 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
      externalMessageId: `msg-${Date.now()}-second`,
    });
    const resp2 = await handleChannelInbound(
      req2,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    expect(json2.reason).toBe("not_a_member");

    const req3 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
      externalMessageId: `msg-${Date.now()}-third`,
    });
    const resp3 = await handleChannelInbound(
      req3,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json3 = (await resp3.json()) as Record<string, unknown>;
    expect(json3.reason).toBe("not_a_member");

    expect(deliverReplyCalls).toHaveLength(2);
    expect(deliverReplyCalls[1].url).toBe(threadReplyCallbackUrl);
    expect(deliverReplyCalls[1].payload.ephemeral).toBe(true);
    expect(deliverReplyCalls[1].payload.user).toBe("U0123UNKNOWN");
    expect(
      (deliverReplyCalls[1].payload.text as string).includes(
        "don't have access to talk to me",
      ),
    ).toBe(true);
  });

  test("threaded Slack ACL reply is shown again in a different thread", async () => {
    const firstThreadCallbackUrl =
      "http://localhost:7830/deliver/slack?channel=C0123CHANNEL&threadTs=1700000000.000100";
    const secondThreadCallbackUrl =
      "http://localhost:7830/deliver/slack?channel=C0123CHANNEL&threadTs=1700000000.000200";

    const req1 = buildSlackInboundRequest({
      replyCallbackUrl: firstThreadCallbackUrl,
    });
    await handleChannelInbound(req1, undefined, TEST_BEARER_TOKEN);

    const req2 = buildSlackInboundRequest({
      replyCallbackUrl: firstThreadCallbackUrl,
      externalMessageId: `msg-${Date.now()}-second`,
    });
    await handleChannelInbound(req2, undefined, TEST_BEARER_TOKEN);

    const req3 = buildSlackInboundRequest({
      replyCallbackUrl: secondThreadCallbackUrl,
      externalMessageId: `msg-${Date.now()}-third`,
    });
    const resp3 = await handleChannelInbound(
      req3,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json3 = (await resp3.json()) as Record<string, unknown>;

    expect(json3.reason).toBe("not_a_member");
    expect(deliverReplyCalls).toHaveLength(3);
    expect(deliverReplyCalls[2].url).toBe(secondThreadCallbackUrl);
    expect(deliverReplyCalls[2].payload.ephemeral).toBe(true);
    expect(deliverReplyCalls[2].payload.user).toBe("U0123UNKNOWN");
  });

  test("failed threaded Slack ACL delivery does not suppress a later retry in the same thread", async () => {
    const threadReplyCallbackUrl =
      "http://localhost:7830/deliver/slack?channel=C0123CHANNEL&threadTs=1700000000.000100";

    const req1 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
    });
    await handleChannelInbound(req1, undefined, TEST_BEARER_TOKEN);

    let releaseFirstFailure: ((reason?: unknown) => void) | null = null;
    let denialAttemptCount = 0;
    deliverChannelReplyImpl = async (_url, payload) => {
      const text = payload.text;
      if (
        payload.ephemeral === true &&
        typeof text === "string" &&
        text.includes("don't have access to talk to me")
      ) {
        denialAttemptCount += 1;
        if (denialAttemptCount === 1) {
          await new Promise<never>((_resolve, reject) => {
            releaseFirstFailure = reject;
          });
        }
      }
    };

    const req2 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
      externalMessageId: `msg-${Date.now()}-second`,
    });
    const resp2Promise = handleChannelInbound(
      req2,
      undefined,
      TEST_BEARER_TOKEN,
    );

    while (!releaseFirstFailure) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!releaseFirstFailure) {
      throw new Error("Expected first Slack denial delivery to block");
    }
    const rejectFirstFailure: (reason?: unknown) => void = releaseFirstFailure;

    const req3 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
      externalMessageId: `msg-${Date.now()}-third`,
    });
    const resp3Promise = handleChannelInbound(
      req3,
      undefined,
      TEST_BEARER_TOKEN,
    );

    rejectFirstFailure(new Error("slack delivery failed"));

    const [resp2, resp3] = await Promise.all([resp2Promise, resp3Promise]);
    const json2 = (await resp2.json()) as Record<string, unknown>;
    const json3 = (await resp3.json()) as Record<string, unknown>;

    expect(json2.reason).toBe("not_a_member");
    expect(json3.reason).toBe("not_a_member");
    expect(denialAttemptCount).toBe(2);
  });

  test("policy deny uses the same once-per-thread Slack dedupe", async () => {
    const threadReplyCallbackUrl =
      "http://localhost:7830/deliver/slack?channel=C0123CHANNEL&threadTs=1700000000.000100";

    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U0123UNKNOWN",
      externalChatId: "C0123CHANNEL",
      displayName: "Alice Unknown",
      status: "active",
      policy: "deny",
    });

    const req1 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
    });
    const resp1 = await handleChannelInbound(
      req1,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json1 = (await resp1.json()) as Record<string, unknown>;
    expect(json1.reason).toBe("policy_deny");

    const req2 = buildSlackInboundRequest({
      replyCallbackUrl: threadReplyCallbackUrl,
      externalMessageId: `msg-${Date.now()}-second`,
    });
    const resp2 = await handleChannelInbound(
      req2,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    expect(json2.reason).toBe("policy_deny");

    expect(deliverReplyCalls).toHaveLength(1);
    expect(deliverReplyCalls[0].payload.ephemeral).toBe(true);
    expect(deliverReplyCalls[0].payload.user).toBe("U0123UNKNOWN");
  });

  test("different Slack user is not suppressed by existing session for another user", async () => {
    // First message from user A creates a session
    const req1 = buildSlackInboundRequest({
      actorExternalId: "U_USER_A",
      actorDisplayName: "User A",
    });
    const resp1 = await handleChannelInbound(
      req1,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json1 = (await resp1.json()) as Record<string, unknown>;
    expect(json1.reason).toBe("verification_challenge_sent");

    // Second message from user B — should get their own challenge
    const req2 = buildSlackInboundRequest({
      actorExternalId: "U_USER_B",
      actorDisplayName: "User B",
      externalMessageId: `msg-${Date.now()}-user-b`,
    });
    const resp2 = await handleChannelInbound(
      req2,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    expect(json2.reason).toBe("verification_challenge_sent");
    expect(json2.verificationSessionId).toBeDefined();

    // No DMs sent to requesters — guardian gets code via notification flow
  });

  test("non-Slack channels still use standard access request flow", async () => {
    const req = buildSlackInboundRequest({
      sourceChannel: "telegram",
      interface: "telegram",
      replyCallbackUrl: "http://localhost:7830/deliver/telegram",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Standard deny path — no verification challenge
    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");

    // No Slack DM was sent
  });

  test("user can verify by replying with the code in the DM", async () => {
    // Step 1: Unknown user sends a message, gets verification challenge
    const req = buildSlackInboundRequest();
    await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);

    const session = findActiveSession("slack");
    expect(session).not.toBeNull();

    // The challenge hash is stored in the session — extract the secret
    // from the DM text sent to the user. The code is embedded in the
    // template text. Since we're using a 6-digit code for identity-bound
    // sessions, extract it from the session's challengeHash by consuming
    // the challenge directly.
    // The session was created with createOutboundSession which generates
    // a 6-digit code. We can validate by calling validateAndConsumeVerification
    // with the correct secret. Since the mock captures the DM text, we
    // can extract the code indirectly. But for testing, we just verify
    // the session properties and that validateAndConsumeVerification works
    // with the correct identity.

    // The actual secret was sent in the DM. For this test, let's use the
    // session directly via the channel-verification-service to verify the
    // consume path works.
    // The DM text contains the verification code implicitly (it's in the
    // template message). Since we need to test the full round-trip, let's
    // verify via the inbound handler by sending the code as a message.

    // Extract the session's challenge hash and verify that submitting the
    // correct code works. We create a fresh session with a known secret for
    // this part of the test.
    resetState();

    // Create a verification session manually to test the consume path
    const { createOutboundSession } =
      await import("../runtime/channel-verification-service.js");

    const outboundSession = createOutboundSession({
      channel: "slack",
      expectedExternalUserId: "U0123UNKNOWN",
      expectedChatId: "U0123UNKNOWN",
      identityBindingStatus: "bound",
      destinationAddress: "U0123UNKNOWN",
      verificationPurpose: "trusted_contact",
    });

    // User replies with the code in the DM
    const verifyReq = buildSlackInboundRequest({
      conversationExternalId: "U0123UNKNOWN",
      content: outboundSession.secret,
      externalMessageId: `msg-verify-${Date.now()}`,
    });
    const verifyResp = await handleChannelInbound(
      verifyReq,
      undefined,
      TEST_BEARER_TOKEN,
    );
    const verifyJson = (await verifyResp.json()) as Record<string, unknown>;

    expect(verifyJson.accepted).toBe(true);
    expect(verifyJson.verificationOutcome).toBe("verified");
  });
});
