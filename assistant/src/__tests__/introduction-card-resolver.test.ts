/**
 * Introduction-card decision tests (LUM-2670).
 *
 * Exercises the four access-request outcomes through the canonical decision
 * primitive: trust (direct, binding-strength-aware), verify_code (handshake),
 * leave_unverified, and block — plus the bot coercion (JARVIS-774) and the
 * kind scoping of introduction actions.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Track lifecycle signal emissions (real pipeline not needed here).
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

// Track requester/guardian channel deliveries.
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

// Member-write relay: record calls instead of hitting gateway IPC.
const activateCalls: Array<Record<string, unknown>> = [];
const seedCalls: Array<Record<string, unknown>> = [];
const blockCalls: Array<Record<string, unknown>> = [];
let activateOutcome: { status: "activated" | "refused" } = {
  status: "activated",
};
let blockOutcome = { revoked: true };
mock.module("../contacts/member-write-relay.js", () => ({
  activateMemberChannel: async (params: Record<string, unknown>) => {
    activateCalls.push(params);
    return activateOutcome.status === "activated"
      ? { status: "activated", memberId: "member-1", member: null }
      : { status: "refused" };
  },
  seedUnverifiedMemberChannel: async (params: Record<string, unknown>) => {
    seedCalls.push(params);
  },
  blockSenderChannel: async (params: Record<string, unknown>) => {
    blockCalls.push(params);
    return blockOutcome;
  },
}));

// Verification sessions: record mints instead of writing session state. The
// resolver mints via the gateway session client.
const sessionMints: Array<Record<string, unknown>> = [];
mock.module("../runtime/channel-verification-service.js", () => ({
  CHALLENGE_TTL_MS: 10 * 60 * 1000,
}));
mock.module("../channels/gateway-verification-sessions.js", () => ({
  createOutboundSession: async (params: Record<string, unknown>) => {
    sessionMints.push(params);
    return {
      sessionId: "session-1",
      secret: "123456",
      challengeHash: "hash",
      expiresAt: Date.now() + 600_000,
      ttlSeconds: 600,
    };
  },
}));

// Card withdrawal is a cosmetic projection — record calls, skip the real
// surface round-trips.
const withdrawCalls: Array<Record<string, unknown>> = [];
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: async (params: Record<string, unknown>) => {
    withdrawCalls.push(params);
  },
}));

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { serializeRequesterSignals } from "../runtime/introduction-policy.js";

await initializeDb();

const TEST_PRINCIPAL_ID = "guardian-principal";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  activateCalls.length = 0;
  seedCalls.length = 0;
  blockCalls.length = 0;
  sessionMints.length = 0;
  withdrawCalls.length = 0;
  activateOutcome = { status: "activated" };
  blockOutcome = { revoked: true };
}

function desktopGuardian(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: undefined,
    channel: "vellum",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

function makeAccessRequest(params: {
  sourceChannel?: string;
  signals?: { isBot?: boolean; isStranger?: boolean; isRestricted?: boolean };
}) {
  return createCanonicalGuardianRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: params.sourceChannel ?? "slack",
    conversationId: "access-req-conv",
    requesterExternalUserId: "U-REQUESTER",
    requesterChatId: "C-CHAT",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    toolName: "ingress_access_request",
    requesterSignals: params.signals
      ? serializeRequesterSignals(params.signals)
      : undefined,
    expiresAt: Date.now() + 60_000,
  });
}

describe("introduction card decisions", () => {
  beforeEach(() => resetState());

  test("trust on a workspace member activates with verifiedVia manual", async () => {
    // Explicit positive signals: users.info resolved a regular member.
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: false, isRestricted: false },
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(getCanonicalGuardianRequest(req.id)?.status).toBe("approved");
    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0].verifiedVia).toBe("manual");
    expect(sessionMints).toHaveLength(0);
  });

  // Regression (ladder honesty): trust-anyway on an external must record
  // inbound_channel_claim provenance — NOT the verified_handshake provenance
  // a code-verified contact carries.
  test("trust-anyway on an external records channel-claim provenance, not handshake", async () => {
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: true },
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0].verifiedVia).toBe("manual_channel_claim");
    expect(activateCalls[0].verifiedVia).not.toBe("challenge");
    // No verification session — direct trust never mints a handshake.
    expect(sessionMints).toHaveLength(0);
  });

  test("verify_code on an external mints a verification session", async () => {
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: true },
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(sessionMints).toHaveLength(1);
    expect(activateCalls).toHaveLength(0);
  });

  test("handshake approval on a bot is coerced to direct trust (JARVIS-774)", async () => {
    for (const action of ["approve_once", "verify_code"] as const) {
      resetState();
      const req = makeAccessRequest({
        sourceChannel: "slack",
        signals: { isBot: true, isStranger: false, isRestricted: false },
      });

      const result = await applyCanonicalGuardianDecision({
        requestId: req.id,
        action,
        actorContext: desktopGuardian(),
      });

      expect(result.applied).toBe(true);
      expect(sessionMints).toHaveLength(0);
      expect(activateCalls).toHaveLength(1);
      // A Slack workspace bot is workspace-vouched → manual provenance.
      expect(activateCalls[0].verifiedVia).toBe("manual");
    }
  });

  test("leave_unverified persists the sender as unverified (legacy reject path)", async () => {
    for (const action of ["leave_unverified", "reject"] as const) {
      resetState();
      const req = makeAccessRequest({ sourceChannel: "slack" });

      const result = await applyCanonicalGuardianDecision({
        requestId: req.id,
        action,
        actorContext: desktopGuardian(),
      });

      expect(result.applied).toBe(true);
      expect(getCanonicalGuardianRequest(req.id)?.status).toBe("denied");
      expect(seedCalls).toHaveLength(1);
      expect(blockCalls).toHaveLength(0);
      expect(activateCalls).toHaveLength(0);
    }
  });

  test("block revokes the sender's channel and resolves to denied", async () => {
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(getCanonicalGuardianRequest(req.id)?.status).toBe("denied");
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0].externalUserId).toBe("U-REQUESTER");
    expect(seedCalls).toHaveLength(0);
    // The terminal decision projects onto the delivered cards.
    expect(withdrawCalls).toHaveLength(1);
  });

  test("block failure surfaces as a resolver failure (fail closed)", async () => {
    blockOutcome = { revoked: false };
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("block_persist_failed");
    // The request is reopened: a failed block must not leave a `denied` row
    // that permanently suppresses re-prompts without the revoke landing.
    expect(getCanonicalGuardianRequest(req.id)?.status).toBe("pending");
    // The reopened request keeps its cards — withdrawing them would strip
    // the guardian's only button path to retry.
    expect(withdrawCalls).toHaveLength(0);
  });

  test("refused trust activation surfaces as a resolver failure (fail closed)", async () => {
    activateOutcome = { status: "refused" };
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("trust_activation_refused");
    // The request is reopened: the sender is not actually trusted.
    expect(getCanonicalGuardianRequest(req.id)?.status).toBe("pending");
    expect(withdrawCalls).toHaveLength(0);
  });

  test("introduction actions are rejected for non-access-request kinds", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    for (const action of [
      "trust",
      "verify_code",
      "leave_unverified",
      "block",
    ] as const) {
      const result = await applyCanonicalGuardianDecision({
        requestId: req.id,
        action,
        actorContext: desktopGuardian(),
      });
      expect(result.applied).toBe(false);
      if (result.applied) {
        continue;
      }
      expect(result.reason).toBe("invalid_action");
    }
    // The request is untouched by the rejected actions.
    expect(getCanonicalGuardianRequest(req.id)?.status).toBe("pending");
  });
});
