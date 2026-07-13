/**
 * Introduction-card decision tests (LUM-2670).
 *
 * Exercises the four access-request outcomes through the guardian decision
 * primitive: trust (direct, binding-strength-aware), verify_code (handshake),
 * leave_unverified, and block — plus the bot coercion (JARVIS-774) and the
 * kind scoping of introduction actions. Each outcome commits as the
 * `aclOutcome` of one atomic `guardian_requests_decide` call; a failed decide
 * leaves the request pending and retryable (nothing to reopen).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// Card withdrawal is a cosmetic projection — record calls, skip the real
// surface round-trips.
const withdrawCalls: Array<Record<string, unknown>> = [];
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: async (params: Record<string, unknown>) => {
    withdrawCalls.push(params);
  },
}));

import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const sim = createGuardianGatewaySim();
mock.module("../channels/gateway-guardian-requests.js", () => sim.module);

import { applyGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import { initializeDb } from "../persistence/db-init.js";
import { serializeRequesterSignals } from "../runtime/introduction-policy.js";

// The resolver enriches decisions with contact display names from the local
// contacts DB; the guardian requests themselves live in the gateway sim.
await initializeDb();

const TEST_PRINCIPAL_ID = "guardian-principal";

function resetState(): void {
  sim.reset();
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  withdrawCalls.length = 0;
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
  return sim.seedRequest({
    kind: "access_request",
    sourceChannel: params.sourceChannel ?? "slack",
    sourceConversationId: "access-req-conv",
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

function outcomesOfType(type: string): Array<Record<string, unknown>> {
  return sim.state.appliedOutcomes.filter((o) => o.type === type);
}

describe("introduction card decisions", () => {
  beforeEach(() => resetState());

  test("trust on a workspace member activates with verifiedVia manual", async () => {
    // Explicit positive signals: users.info resolved a regular member.
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: false, isRestricted: false },
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(sim.getRequest(req.id)?.status).toBe("approved");
    const activations = outcomesOfType("activate_member");
    expect(activations).toHaveLength(1);
    expect(activations[0].verifiedVia).toBe("manual");
    expect(outcomesOfType("mint_outbound_session")).toHaveLength(0);
  });

  // Regression (ladder honesty): trust-anyway on an external must record
  // inbound_channel_claim provenance — NOT the verified_handshake provenance
  // a code-verified contact carries.
  test("trust-anyway on an external records channel-claim provenance, not handshake", async () => {
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: true },
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    const activations = outcomesOfType("activate_member");
    expect(activations).toHaveLength(1);
    expect(activations[0].verifiedVia).toBe("manual_channel_claim");
    expect(activations[0].verifiedVia).not.toBe("challenge");
    // No verification session — direct trust never mints a handshake.
    expect(outcomesOfType("mint_outbound_session")).toHaveLength(0);
  });

  test("verify_code on an external mints a verification session atomically", async () => {
    const req = makeAccessRequest({
      sourceChannel: "slack",
      signals: { isStranger: true },
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const mints = outcomesOfType("mint_outbound_session");
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({
      channel: "slack",
      expectedExternalUserId: "U-REQUESTER",
      expectedChatId: "C-CHAT",
      identityBindingStatus: "bound",
      destinationAddress: "C-CHAT",
      verificationPurpose: "trusted_contact",
    });
    expect(outcomesOfType("activate_member")).toHaveLength(0);
    // The desktop guardian receives the minted secret inline.
    expect(result.resolverReplyText).toContain(sim.state.mintedSecret);
  });

  test("handshake approval on a bot is coerced to direct trust (JARVIS-774)", async () => {
    for (const action of ["approve_once", "verify_code"] as const) {
      resetState();
      const req = makeAccessRequest({
        sourceChannel: "slack",
        signals: { isBot: true, isStranger: false, isRestricted: false },
      });

      const result = await applyGuardianDecision({
        requestId: req.id,
        action,
        actorContext: desktopGuardian(),
      });

      expect(result.applied).toBe(true);
      expect(outcomesOfType("mint_outbound_session")).toHaveLength(0);
      const activations = outcomesOfType("activate_member");
      expect(activations).toHaveLength(1);
      // A Slack workspace bot is workspace-vouched → manual provenance.
      expect(activations[0].verifiedVia).toBe("manual");
    }
  });

  test("leave_unverified persists the sender as unverified (legacy reject path)", async () => {
    for (const action of ["leave_unverified", "reject"] as const) {
      resetState();
      const req = makeAccessRequest({ sourceChannel: "slack" });

      const result = await applyGuardianDecision({
        requestId: req.id,
        action,
        actorContext: desktopGuardian(),
      });

      expect(result.applied).toBe(true);
      expect(sim.getRequest(req.id)?.status).toBe("denied");
      expect(outcomesOfType("seed_unverified")).toHaveLength(1);
      expect(outcomesOfType("block")).toHaveLength(0);
      expect(outcomesOfType("activate_member")).toHaveLength(0);
    }
  });

  test("block revokes the sender's channel and resolves to denied", async () => {
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(sim.getRequest(req.id)?.status).toBe("denied");
    const blocks = outcomesOfType("block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].externalUserId).toBe("U-REQUESTER");
    expect(blocks[0].reason).toBe("introduction_block");
    expect(outcomesOfType("seed_unverified")).toHaveLength(0);
    // The terminal decision projects onto the delivered cards.
    expect(withdrawCalls).toHaveLength(1);
  });

  test("block persist failure leaves the request pending and retryable (fail closed)", async () => {
    sim.state.outcomeError = new Error("gateway block write failed");
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyGuardianDecision({
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
    // The gateway transaction rolled back: no `denied` row ever existed to
    // suppress re-prompts without the revoke landing.
    expect(sim.getRequest(req.id)?.status).toBe("pending");
    // The pending request keeps its cards — withdrawing them would strip
    // the guardian's only button path to retry.
    expect(withdrawCalls).toHaveLength(0);
  });

  test("trust activation failure leaves the request pending and retryable (fail closed)", async () => {
    sim.state.outcomeError = new Error("gateway refused the activation");
    const req = makeAccessRequest({ sourceChannel: "slack" });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "trust",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("trust_activation_failed");
    // Nothing committed: the sender is not trusted and the request stays
    // decidable.
    expect(sim.getRequest(req.id)?.status).toBe("pending");
    expect(withdrawCalls).toHaveLength(0);
  });

  test("block without a channel identity aborts before any status write", async () => {
    const req = sim.seedRequest({
      kind: "access_request",
      sourceChannel: "vellum",
      sourceConversationId: "access-req-conv",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("block_missing_channel_identity");
    // No decide was ever attempted.
    expect(sim.state.decideCalls).toHaveLength(0);
    expect(sim.getRequest(req.id)?.status).toBe("pending");
  });

  test("introduction actions are rejected for non-access-request kinds", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
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
      const result = await applyGuardianDecision({
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
    expect(sim.getRequest(req.id)?.status).toBe("pending");
  });
});
