/**
 * ATL-463: the daemon's access_request phone resolver relay is the authoritative
 * grant for voice approvals. These tests pin that relay's contract so no
 * approved-but-ungranted state is ever silently lost:
 *
 *   - happy path: activation lands  → applied, no resolverFailed, status approved
 *   - relay throws (voice_activation_failed)   → resolverFailed surfaced upstream
 *   - gateway refuses (voice_activation_refused) → resolverFailed surfaced upstream
 *
 * On failure the resolver REOPENS the request to `pending` (via
 * reopenAccessRequestAfterFailedPersist) with `resolverFailed`/
 * `resolverFailureReason` set: leaving the row `approved` would suppress
 * re-prompts for a grant the gateway never persisted. Reopening keeps the
 * request decidable — the guardian can re-approve and the request code stays
 * live (the expiry sweep re-enables discovery if no retry comes), so the
 * failure is neither silent nor a stuck approved-but-ungranted state.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type ActivateOutcome =
  | { status: "activated"; memberId: string; member: null }
  | { status: "refused" };

let activateBehavior: () =>
  | Promise<ActivateOutcome>
  | ActivateOutcome = () => ({
  status: "activated",
  memberId: "member-1",
  member: null,
});

mock.module("../contacts/member-write-relay.js", () => ({
  activateMemberChannel: () => activateBehavior(),
  seedUnverifiedMemberChannel: () => {},
}));

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const TEST_PRINCIPAL_ID = "voice-relay-principal";

function guardianActor(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: "+15550001111",
    channel: "phone",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

function seedPhoneAccessRequest(): string {
  const req = createCanonicalGuardianRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "phone",
    conversationId: "voice-conv-1",
    requesterExternalUserId: "+15559998888",
    requesterChatId: "+15559998888",
    guardianExternalUserId: "+15550001111",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    toolName: "ingress_access_request",
    expiresAt: Date.now() + 60_000,
  });
  return req.id;
}

describe("voice approval resolver relay (ATL-463)", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM canonical_guardian_requests");
    activateBehavior = () => ({
      status: "activated",
      memberId: "member-1",
      member: null,
    });
  });

  test("activation lands: applied, no resolver failure, request approved", async () => {
    const requestId = seedPhoneAccessRequest();

    const result = await applyCanonicalGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBeUndefined();
    expect(getCanonicalGuardianRequest(requestId)!.status).toBe("approved");
  });

  test("relay throws: failure is surfaced (voice_activation_failed), not silent", async () => {
    activateBehavior = () => {
      throw new Error("gateway unreachable");
    };
    const requestId = seedPhoneAccessRequest();

    const result = await applyCanonicalGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    // applied:true reflects the committed CAS status, but the failure is flagged
    // so callers surface it to the guardian rather than silently dropping it.
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("voice_activation_failed");
    expect(result.grantMinted).toBe(false);
    // The failed persist reopens the request to `pending` so the guardian can
    // re-approve rather than being stuck in an approved-but-ungranted state.
    expect(getCanonicalGuardianRequest(requestId)!.status).toBe("pending");
  });

  test("gateway refuses: failure is surfaced (voice_activation_refused), not silent", async () => {
    activateBehavior = () => ({ status: "refused" });
    const requestId = seedPhoneAccessRequest();

    const result = await applyCanonicalGuardianDecision({
      requestId,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("voice_activation_refused");
    expect(result.grantMinted).toBe(false);
    // A refused activation also reopens to `pending` — the gateway never
    // recorded the grant, so the row must not stay terminally approved.
    expect(getCanonicalGuardianRequest(requestId)!.status).toBe("pending");
  });
});
