/**
 * ATL-463: guardian decisions commit through `guardian_requests_decide` — the
 * status CAS and the ACL outcome land in ONE gateway transaction. These tests
 * pin the atomic contract for the voice access_request path:
 *
 *   - happy path: ONE decide call carries the CAS and the activate_member
 *     outcome → applied, no resolverFailed, request approved gateway-side
 *   - induced decide failure (gateway outcome write throws → transaction
 *     rollback): the request STAYS pending and retryable; the failure
 *     surfaces via `resolverFailed`/`resolverFailureReason`
 *   - retry after a failed decide succeeds (nothing was consumed)
 *
 * There is no reopen machinery: a failed persist never leaves a terminal row
 * to repair, so `reopenAccessRequestAfterFailedPersist` does not exist — the
 * source-scan test at the bottom pins its absence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const sim = createGuardianGatewaySim();
mock.module("../channels/gateway-guardian-requests.js", () => sim.module);

import { applyGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import { initializeDb } from "../persistence/db-init.js";

// The resolver enriches decisions with contact display names from the local
// contacts DB; the guardian requests themselves live in the gateway sim.
await initializeDb();

const TEST_PRINCIPAL_ID = "voice-relay-principal";

function guardianActor(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: "+15555550111",
    channel: "phone",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

function seedPhoneAccessRequest(): string {
  const req = sim.seedRequest({
    kind: "access_request",
    sourceChannel: "phone",
    sourceConversationId: "voice-conv-1",
    requesterExternalUserId: "+15555550188",
    requesterChatId: "+15555550188",
    guardianExternalUserId: "+15555550111",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    toolName: "ingress_access_request",
    expiresAt: Date.now() + 60_000,
  });
  return req.id;
}

describe("voice approval atomic decide (ATL-463)", () => {
  beforeEach(() => {
    sim.reset();
  });

  test("happy path: one decide call carries CAS + activate_member outcome", async () => {
    const requestId = seedPhoneAccessRequest();

    const result = await applyGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBeUndefined();
    expect(sim.getRequest(requestId)!.status).toBe("approved");

    // Exactly one decide, CAS'd from pending, carrying the ACL outcome.
    expect(sim.state.decideCalls).toHaveLength(1);
    const call = sim.state.decideCalls[0];
    expect(call.expectedStatus).toBe("pending");
    expect(call.status).toBe("approved");
    expect(call.aclOutcome).toEqual({
      type: "activate_member",
      sourceChannel: "phone",
      externalUserId: "+15555550188",
      externalChatId: "+15555550188",
    });
    expect(sim.state.appliedOutcomes).toHaveLength(1);
  });

  test("decide failure: request stays pending and retryable, failure surfaced", async () => {
    sim.state.outcomeError = new Error("gateway activation write failed");
    const requestId = seedPhoneAccessRequest();

    const result = await applyGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    // The failure is flagged so callers surface it to the guardian rather
    // than silently dropping it; nothing was committed gateway-side.
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("voice_activation_failed");
    expect(result.grantMinted).toBe(false);
    // The gateway transaction rolled back: the request is still pending —
    // there is no approved-but-ungranted window and nothing to reopen.
    expect(sim.getRequest(requestId)!.status).toBe("pending");
    expect(sim.state.appliedOutcomes).toHaveLength(0);

    // Retry after the gateway recovers: the same decision applies cleanly.
    sim.state.outcomeError = null;
    const retry = await applyGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });
    expect(retry.applied).toBe(true);
    if (!retry.applied) return;
    expect(retry.resolverFailed).toBeUndefined();
    expect(sim.getRequest(requestId)!.status).toBe("approved");
    expect(sim.state.appliedOutcomes).toHaveLength(1);
  });

  test("gateway unreachable: decide throw leaves the request pending", async () => {
    sim.state.decideError = new Error("gateway unreachable");
    const requestId = seedPhoneAccessRequest();

    const result = await applyGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("voice_activation_failed");
    expect(sim.getRequest(requestId)!.status).toBe("pending");
  });

  test("decide is first-writer-wins: a raced decision maps to already_resolved", async () => {
    const requestId = seedPhoneAccessRequest();
    // Simulate a concurrent writer landing between the primitive's pending
    // read and its decide: mark the row approved out from under it.
    const first = await applyGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });
    expect(first.applied).toBe(true);

    const second = await applyGuardianDecision({
      requestId,
      action: "reject",
      actorContext: guardianActor(),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe("already_resolved");
    // No second outcome was ever applied.
    expect(sim.state.appliedOutcomes).toHaveLength(1);
  });

  test("no reopen machinery exists in the decision cluster", () => {
    const approvalsDir = join(import.meta.dir, "..", "approvals");
    for (const file of [
      "guardian-request-resolvers.ts",
      "guardian-decision-primitive.ts",
    ]) {
      const source = readFileSync(join(approvalsDir, file), "utf8");
      expect(source).not.toContain("reopenAccessRequestAfterFailedPersist");
      expect(source).not.toContain("reopenGuardianRequest");
    }
  });
});
