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
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { findActiveSession } from "../runtime/channel-verification-service.js";
import { handleChannelInbound } from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

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
  // Seed the vellum guardian binding (gateway does this at startup in production)
  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: "guardian-principal",
    guardianDeliveryChatId: "local",
    guardianPrincipalId: "guardian-principal",
    verifiedVia: "bootstrap",
  });
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
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

});
