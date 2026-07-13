import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const sim = createGuardianGatewaySim();
mock.module("../channels/gateway-guardian-requests.js", () => sim.module);

import {
  applyGuardianDecision,
  GRANT_TTL_MS,
  mintGuardianRequestGrant,
} from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  getRegisteredKinds,
  getResolver,
} from "../approvals/guardian-request-resolvers.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { scopedApprovalGrants } from "../persistence/schema/index.js";

await initializeDb();

function resetState(): void {
  sim.reset();
  getDb().run("DELETE FROM scoped_approval_grants");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consistent test principal used across all test actors and requests. */
const TEST_PRINCIPAL_ID = "test-principal-id";

function guardianActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: "guardian-1",
    channel: "telegram",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    ...overrides,
  };
}

function trustedActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: undefined,
    channel: "desktop",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Resolver registry tests
// ---------------------------------------------------------------------------

describe("guardian-request-resolvers / registry", () => {
  test("built-in resolvers are registered", () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain("tool_approval");
    expect(kinds).toContain("pending_question");
  });

  test("getResolver returns undefined for unknown kind", () => {
    expect(getResolver("nonexistent_kind")).toBeUndefined();
  });

  test("getResolver returns resolver for known kind", () => {
    const resolver = getResolver("tool_approval");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("tool_approval");
  });
});

// ---------------------------------------------------------------------------
// applyGuardianDecision tests
// ---------------------------------------------------------------------------

describe("applyGuardianDecision", () => {
  beforeEach(() => resetState());

  // ── Successful approval ─────────────────────────────────────────────

  test("approves a pending tool_approval request", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.requestId).toBe(req.id);
    // Grant is not minted because the tool_approval resolver fails (no pending
    // interaction registered in the test environment). The decision primitive
    // correctly skips grant minting when the resolver reports a failure.
    expect(result.grantMinted).toBe(false);
    expect(result.resolverFailed).toBe(true);

    // Verify gateway-side request state
    const resolved = sim.getRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("denies a pending tool_approval request", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(false);

    expect(sim.getRequest(req.id)!.status).toBe("denied");
  });

  test("approves a pending_question request with answer text", async () => {
    const req = sim.seedRequest({
      kind: "pending_question",
      sourceChannel: "twilio",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-1",
      pendingQuestionId: "pq-1",
      questionText: "What is the gate code?",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      userText: "1234",
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;

    const resolved = sim.getRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.answerText).toBe("1234");
  });

  // ── Daemon-domain kinds decide as a plain CAS ───────────────────────

  test("tool_approval decide carries no aclOutcome", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(sim.state.decideCalls).toHaveLength(1);
    expect(sim.state.decideCalls[0].aclOutcome).toBeUndefined();
  });

  test("a failed plain-CAS decide leaves the request pending and surfaces resolverFailed", async () => {
    sim.state.decideError = new Error("gateway unreachable");
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toBe("decision_persist_failed");
    expect(result.grantMinted).toBe(false);
    expect(sim.getRequest(req.id)!.status).toBe("pending");
  });

  // ── Principal mismatch ──────────────────────────────────────────────

  test("rejects decision when actor principal does not match request principal", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: "wrong-principal" }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");

    // Request remains pending; no decide was attempted
    expect(sim.getRequest(req.id)!.status).toBe("pending");
    expect(sim.state.decideCalls).toHaveLength(0);
  });

  test("matching principal authorizes decision (cross-channel same principal)", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "vellum",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: trustedActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    // No grant minted because trusted actor has no actorExternalUserId
    expect(result.grantMinted).toBe(false);
  });

  test("rejects decision when request has no guardianPrincipalId", async () => {
    // A request with no bound principal can never be authorized by anyone —
    // this is a data-integrity fault (request_misconfigured), not an
    // authorization denial against the actor, so it must not be reported as
    // identity_mismatch / "no permission".
    const req = sim.seedRequest({
      kind: "unknown_kind",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: "some-principal" }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("request_misconfigured");
  });

  test("rejects decision when actor has no guardianPrincipalId", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: undefined }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");
  });

  // ── Stale / already-resolved (race condition) ──────────────────────

  test("second concurrent decision fails (first-writer-wins)", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    // First decision succeeds
    const first = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });
    expect(first.applied).toBe(true);

    // Second decision fails — request is no longer pending
    const second = await applyGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe("already_resolved");

    // First decision stuck
    expect(sim.getRequest(req.id)!.status).toBe("approved");
  });

  test("a decide CAS miss maps to already_resolved", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    // Race a concurrent writer between the primitive's pending read and its
    // decide call: the row flips terminal right before the CAS runs.
    sim.state.beforeDecide = () => {
      sim.requests.get(req.id)!.status = "approved";
    };

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("already_resolved");
  });

  // ── Not found ──────────────────────────────────────────────────────

  test("returns not_found for nonexistent request", async () => {
    const result = await applyGuardianDecision({
      requestId: "nonexistent-id",
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("not_found");
  });

  // ── Invalid action ─────────────────────────────────────────────────

  test("rejects invalid action", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "bogus_action" as any,
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("invalid_action");

    // Request remains pending
    expect(sim.getRequest(req.id)!.status).toBe("pending");
  });

  // ── approve_always / temporal actions are no longer valid ──────────

  test("rejects approve_always as invalid_action", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      // @ts-expect-error - approve_always is no longer a valid action
      action: "approve_always",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe("invalid_action");
    }
  });

  test("rejects approve_10m as invalid_action", async () => {
    const req = sim.seedRequest({
      kind: "unknown_kind",
      sourceChannel: "phone",
      sourceConversationId: "conv-10m-1",
      callSessionId: "call-10m-1",
      toolName: "host_bash",
      inputDigest: "sha256:10m-digest",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      // @ts-expect-error - approve_10m is no longer a valid action
      action: "approve_10m",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe("invalid_action");
    }
  });

  test("rejects approve_conversation as invalid_action", async () => {
    const req = sim.seedRequest({
      kind: "unknown_kind",
      sourceChannel: "phone",
      sourceConversationId: "conv-session-1",
      callSessionId: "call-session-1",
      toolName: "file_write",
      inputDigest: "sha256:session-digest",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      // @ts-expect-error - approve_conversation is no longer a valid action
      action: "approve_conversation",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe("invalid_action");
    }
  });

  // ── Expired request ────────────────────────────────────────────────

  test("rejects decision on expired request", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() - 10_000, // already expired
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("expired");
  });

  test("allows decision on request with no expiresAt", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      // No expiresAt
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
  });

  // ── Resolver dispatch ──────────────────────────────────────────────

  test("dispatches to tool_approval resolver", async () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "file_read",
      inputDigest: "sha256:def",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
  });

  test("dispatches to pending_question resolver", async () => {
    const req = sim.seedRequest({
      kind: "pending_question",
      sourceChannel: "twilio",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-99",
      pendingQuestionId: "pq-99",
      questionText: "What is the password?",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      userText: "secret123",
    });

    expect(result.applied).toBe(true);
    const resolved = sim.getRequest(req.id);
    expect(resolved!.answerText).toBe("secret123");
  });

  test("succeeds for non-decisionable kind with matching principal", async () => {
    const req = sim.seedRequest({
      kind: "unknown_kind",
      sourceConversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    // Should still succeed — CAS resolution happens regardless of resolver
    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    expect(sim.getRequest(req.id)!.status).toBe("approved");
  });

  test("desktop actor with matching principal mints scoped grant for approved request", async () => {
    const req = sim.seedRequest({
      kind: "unknown_kind",
      sourceChannel: "phone",
      sourceConversationId: "conv-voice-1",
      callSessionId: "call-voice-1",
      toolName: "host_bash",
      inputDigest: "sha256:voice-digest-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: trustedActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(true);

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].toolName).toBe("host_bash");
    expect(grants[0].conversationId).toBe("conv-voice-1");
    expect(grants[0].callSessionId).toBe("call-voice-1");
    expect(grants[0].guardianExternalUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mintGuardianRequestGrant tests
// ---------------------------------------------------------------------------

describe("mintGuardianRequestGrant", () => {
  beforeEach(() => resetState());

  test("mints grant for request with tool metadata", () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
    });

    const result = mintGuardianRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
      effectiveAction: "approve_once",
    });

    expect(result.minted).toBe(true);
  });

  test("mints grant when guardianExternalUserId is omitted", () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-2",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:xyz",
    });

    const result = mintGuardianRequestGrant({
      request: req,
      actorChannel: "vellum",
      effectiveAction: "approve_once",
    });

    expect(result.minted).toBe(true);

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].guardianExternalUserId).toBeNull();
  });

  test("skips grant for request without tool metadata", () => {
    const req = sim.seedRequest({
      kind: "pending_question",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      // No toolName or inputDigest
    });

    const result = mintGuardianRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
      effectiveAction: "approve_once",
    });

    expect(result.minted).toBe(false);
  });

  test("skips grant when toolName present but inputDigest missing", () => {
    const req = sim.seedRequest({
      kind: "tool_approval",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      // No inputDigest
    });

    const result = mintGuardianRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
      effectiveAction: "approve_once",
    });

    expect(result.minted).toBe(false);
  });

  test("mints grant with default 5m TTL for approve_once", () => {
    const before = Date.now();
    const req = sim.seedRequest({
      kind: "tool_approval",
      sourceChannel: "telegram",
      sourceConversationId: "conv-ttl-once",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:ttl-once",
    });

    const result = mintGuardianRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
      effectiveAction: "approve_once",
    });

    expect(result.minted).toBe(true);

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].expiresAt).toBeGreaterThanOrEqual(before + GRANT_TTL_MS);
    expect(grants[0].expiresAt).toBeLessThanOrEqual(Date.now() + GRANT_TTL_MS);
  });
});
