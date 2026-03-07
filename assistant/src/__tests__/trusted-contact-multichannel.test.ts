/**
 * Tests verifying the trusted contact flow is channel-agnostic.
 *
 * The access request -> guardian notification -> verification -> activation
 * flow should work identically across all channels.
 * These tests confirm no channel-specific assumptions leaked into the
 * trusted contact code paths.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "trusted-contact-multichannel-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

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
  registerBroadcastFn: () => {},
}));

// Mock access-request-helper directly to capture notification calls.
// Bun's mock.module does not intercept transitive imports reliably, so
// mocking emit-signal.js alone is not sufficient — access-request-helper
// imports emit-signal before the mock takes effect.
const notifyGuardianCalls: Array<Record<string, unknown>> = [];
mock.module("../runtime/access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: (params: Record<string, unknown>) => {
    notifyGuardianCalls.push(params);
    return {
      notified: true,
      created: true,
      requestId: `mock-req-${Date.now()}`,
    };
  },
}));

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

mock.module("../runtime/approval-message-composer.js", () => ({
  composeApprovalMessage: () => "mock approval message",
  composeApprovalMessageGenerative: async () => "mock generative message",
}));

import { findContactChannel } from "../contacts/contact-store.js";
import {
  createGuardianBinding,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createOutboundSession,
  validateAndConsumeChallenge,
} from "../runtime/channel-guardian-service.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

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
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  notifyGuardianCalls.length = 0;
  deliverReplyCalls.length = 0;
}

interface ChannelTestConfig {
  channel: "telegram" | "slack";
  deliverEndpoint: string;
  senderExternalUserId: string;
  externalChatId: string;
  guardianExternalUserId: string;
  guardianChatId: string;
}

const CHANNEL_CONFIGS: ChannelTestConfig[] = [
  {
    channel: "telegram",
    deliverEndpoint: "/deliver/telegram",
    senderExternalUserId: "tg-user-456",
    externalChatId: "tg-chat-456",
    guardianExternalUserId: "tg-guardian-789",
    guardianChatId: "tg-guardian-chat-789",
  },
  {
    channel: "slack",
    deliverEndpoint: "/deliver/slack",
    senderExternalUserId: "U0123ABCDEF",
    externalChatId: "C0123ABCDEF",
    guardianExternalUserId: "U9876ZYXWVU",
    guardianChatId: "C9876ZYXWVU",
  },
];

function buildInboundRequest(
  config: ChannelTestConfig,
  overrides: Record<string, unknown> = {},
): Request {
  const body: Record<string, unknown> = {
    sourceChannel: config.channel,
    interface: config.channel,
    conversationExternalId: config.externalChatId,
    externalMessageId: `msg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    content: "Hello, can I use this assistant?",
    actorExternalId: config.senderExternalUserId,
    actorDisplayName: "Test Requester",
    actorUsername: "test_requester",
    replyCallbackUrl: `http://localhost:7830${config.deliverEndpoint}`,
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
// Parameterized tests for each channel
// ---------------------------------------------------------------------------

for (const config of CHANNEL_CONFIGS) {
  describe(`trusted contact flow on ${config.channel} channel`, () => {
    beforeEach(() => {
      resetState();
    });

    test("non-member message is denied with rejection reply", async () => {
      const req = buildInboundRequest(config);
      const resp = await handleChannelInbound(
        req,
        undefined,
        TEST_BEARER_TOKEN,
      );
      const json = (await resp.json()) as Record<string, unknown>;

      expect(json.denied).toBe(true);
      expect(json.reason).toBe("not_a_member");
      expect(deliverReplyCalls.length).toBe(1);
      const replyText = (
        deliverReplyCalls[0].payload as Record<string, unknown>
      ).text as string;
      expect(
        replyText.includes("you haven't been approved") ||
          replyText.includes("you don't have access"),
      ).toBe(true);
    });

    test("guardian is notified when a non-member messages", async () => {
      createGuardianBinding({
        channel: config.channel,
        guardianExternalUserId: config.guardianExternalUserId,
        guardianDeliveryChatId: config.guardianChatId,
        guardianPrincipalId: config.guardianExternalUserId,
        verifiedVia: "test",
      });

      const req = buildInboundRequest(config);
      const resp = await handleChannelInbound(
        req,
        undefined,
        TEST_BEARER_TOKEN,
      );
      const json = (await resp.json()) as Record<string, unknown>;

      expect(json.denied).toBe(true);

      // Guardian notification helper was called for the correct channel
      expect(notifyGuardianCalls.length).toBe(1);
      expect(notifyGuardianCalls[0].sourceChannel).toBe(config.channel);
      expect(notifyGuardianCalls[0].actorExternalId).toBe(
        config.senderExternalUserId,
      );
    });

    test("verification creates active member for channel", () => {
      const session = createOutboundSession({
        channel: config.channel,
        expectedExternalUserId: config.senderExternalUserId,
        expectedChatId: config.externalChatId,
        identityBindingStatus: "bound",
        destinationAddress: config.externalChatId,
        verificationPurpose: "trusted_contact",
      });

      const challengeResult = validateAndConsumeChallenge(
        config.channel,
        session.secret,
        config.senderExternalUserId,
        config.externalChatId,
        "test_requester",
        "Test Requester",
      );

      expect(challengeResult.success).toBe(true);
      if (challengeResult.success) {
        expect(challengeResult.verificationType).toBe("trusted_contact");
      }

      upsertContactChannel({
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
        externalChatId: config.externalChatId,
        status: "active",
        policy: "allow",
        displayName: "Test Requester",
        username: "test_requester",
      });

      const contactResult = findContactChannel({
        channelType: config.channel,
        externalUserId: config.senderExternalUserId,
      });

      expect(contactResult).not.toBeNull();
      expect(contactResult!.channel.status).toBe("active");
      expect(contactResult!.channel.policy).toBe("allow");
      expect(contactResult!.channel.type).toBe(config.channel);
    });

    test("no cross-channel leakage between member records", () => {
      // Create a member for this channel
      upsertContactChannel({
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
        externalChatId: config.externalChatId,
        status: "active",
        policy: "allow",
      });

      // Should be found on this channel
      const sameChanResult = findContactChannel({
        channelType: config.channel,
        externalUserId: config.senderExternalUserId,
      });
      expect(sameChanResult).not.toBeNull();

      // Should NOT be found on a different channel
      const otherChannel = config.channel === "telegram" ? "slack" : "telegram";
      const crossChanResult = findContactChannel({
        channelType: otherChannel,
        externalUserId: config.senderExternalUserId,
      });
      expect(crossChanResult).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// Voice-specific: phone E.164 identity binding
// ---------------------------------------------------------------------------

describe("voice identity binding with E.164 phone numbers", () => {
  beforeEach(() => {
    resetState();
  });

  test("voice verification session binds to phone E.164", () => {
    const phone = "+15551234567";
    const session = createOutboundSession({
      channel: "voice",
      expectedExternalUserId: phone,
      expectedPhoneE164: phone,
      expectedChatId: phone,
      identityBindingStatus: "bound",
      destinationAddress: phone,
      verificationPurpose: "trusted_contact",
    });

    // Verify with matching phone identity
    const result = validateAndConsumeChallenge(
      "voice",
      session.secret,
      phone,
      phone,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
    }
  });

  test("voice verification rejects mismatched phone identity", () => {
    const expectedPhone = "+15551234567";
    const wrongPhone = "+15559999999";

    const session = createOutboundSession({
      channel: "voice",
      expectedExternalUserId: expectedPhone,
      expectedPhoneE164: expectedPhone,
      expectedChatId: expectedPhone,
      identityBindingStatus: "bound",
      destinationAddress: expectedPhone,
    });

    // Try to verify with a different phone (anti-oracle: same error message)
    const result = validateAndConsumeChallenge(
      "voice",
      session.secret,
      wrongPhone,
      wrongPhone,
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-channel: same user on different channels gets separate sessions
// ---------------------------------------------------------------------------

describe("cross-channel isolation", () => {
  beforeEach(() => {
    resetState();
  });

  test("verification sessions are scoped per channel", () => {
    // Create sessions on both channels
    const telegramSession = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-123",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
    });

    const slackSession = createOutboundSession({
      channel: "slack",
      expectedExternalUserId: "U0123ABCDEF",
      expectedChatId: "C0123ABCDEF",
      identityBindingStatus: "bound",
      destinationAddress: "C0123ABCDEF",
    });

    // Telegram code should not work on Slack channel
    const wrongChannelResult = validateAndConsumeChallenge(
      "slack",
      telegramSession.secret,
      "U0123ABCDEF",
      "C0123ABCDEF",
    );
    expect(wrongChannelResult.success).toBe(false);

    // Slack code should work on Slack channel
    const correctChannelResult = validateAndConsumeChallenge(
      "slack",
      slackSession.secret,
      "U0123ABCDEF",
      "C0123ABCDEF",
    );
    expect(correctChannelResult.success).toBe(true);
  });
});
