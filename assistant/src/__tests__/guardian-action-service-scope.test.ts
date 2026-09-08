/**
 * Conversation scoping for in-app guardian decisions
 * (`processGuardianDecision` step 2).
 *
 * A guardian request projects an actionable card into every conversation a
 * delivery was paired with: the vellum card's pinned conversation AND each
 * channel card's paired conversation (the decision engine injects the same
 * seed blocks into every channel's copy). Taps from any of those
 * conversations are legitimate; taps from unrelated conversations are not.
 * The scope check must therefore accept any recorded delivery destination
 * conversation regardless of the delivery's channel: narrowing to vellum
 * rows silently no-opped every tap on a channel card's in-app projection
 * (LUM-3489's "one request, two independent tasks" confusion).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

const applyGuardianDecision = mock(async () => ({
  applied: true as const,
  requestId: "req",
  grantMinted: false,
}));
const actualPrimitive =
  await import("../approvals/guardian-decision-primitive.js");
mock.module("../approvals/guardian-decision-primitive.js", () => ({
  ...actualPrimitive,
  applyGuardianDecision,
}));

import { processGuardianDecision } from "../runtime/guardian-action-service.js";

const PRINCIPAL_ID = "scope-test-principal";

function seedRequestWithProjections() {
  const req = bridgeState.seedRequest({
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "slack",
    sourceConversationId: "conv-thread",
    toolName: "shell",
    guardianPrincipalId: PRINCIPAL_ID,
  });
  bridgeState.seedDelivery({
    requestId: req.id,
    destinationChannel: "vellum",
    destinationConversationId: "conv-thread",
  });
  bridgeState.seedDelivery({
    requestId: req.id,
    destinationChannel: "slack",
    destinationChatId: "C1",
    destinationMessageId: "1.0",
    destinationConversationId: "conv-dm",
  });
  return req;
}

async function decideFrom(requestId: string, conversationId: string) {
  return processGuardianDecision({
    requestId,
    action: "approve_once",
    conversationId,
    channel: "vellum",
    actorContext: {
      actorPrincipalId: PRINCIPAL_ID,
      guardianPrincipalId: PRINCIPAL_ID,
    },
  });
}

describe("processGuardianDecision conversation scoping", () => {
  beforeEach(() => {
    bridgeState.reset();
    applyGuardianDecision.mockClear();
  });

  test("accepts a tap from the request's source conversation", async () => {
    const req = seedRequestWithProjections();
    const result = await decideFrom(req.id, "conv-thread");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(applyGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("accepts a tap from a channel card's paired conversation", async () => {
    const req = seedRequestWithProjections();
    const result = await decideFrom(req.id, "conv-dm");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(applyGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test("rejects a tap from a conversation holding no projection", async () => {
    const req = seedRequestWithProjections();
    const result = await decideFrom(req.id, "conv-unrelated");
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      reason: "not_found",
    });
    expect(applyGuardianDecision).not.toHaveBeenCalled();
  });

  test("threads the acting conversation to the primitive for broadcast suppression", async () => {
    const req = seedRequestWithProjections();
    await decideFrom(req.id, "conv-dm");
    expect(applyGuardianDecision).toHaveBeenCalledWith(
      expect.objectContaining({ originConversationId: "conv-dm" }),
    );
  });
});

describe("processGuardianDecision resolver failures", () => {
  beforeEach(() => {
    bridgeState.reset();
    applyGuardianDecision.mockClear();
  });

  // The primitive reports both under `resolverFailed`; the route tells them
  // apart for the client, which retires a committed decision and keeps a
  // failed persist retryable.
  test("a committed decision whose follow-through failed is resolver_failed", async () => {
    const req = seedRequestWithProjections();
    applyGuardianDecision.mockResolvedValueOnce({
      applied: true as const,
      requestId: req.id,
      grantMinted: false,
      decidedAction: "approve_once",
      resolverFailed: true,
      resolverFailureReason: "resolver_threw",
    } as never);

    const result = await decideFrom(req.id, "conv-thread");

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      reason: "resolver_failed",
      committed: true,
      resolverFailureReason: "resolver_threw",
    });
  });

  test("a decision whose persist never landed is decision_not_persisted", async () => {
    const req = seedRequestWithProjections();
    applyGuardianDecision.mockResolvedValueOnce({
      applied: true as const,
      requestId: req.id,
      grantMinted: false,
      resolverFailed: true,
      resolverFailureReason: "gateway_unreachable",
    } as never);

    const result = await decideFrom(req.id, "conv-thread");

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      reason: "decision_not_persisted",
      committed: false,
      resolverFailureReason: "gateway_unreachable",
    });
  });
});
