import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "canonical-decision-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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
  truncateForLog: (value: string) => value,
}));

import {
  applyCanonicalGuardianDecision,
  mintCanonicalRequestGrant,
} from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  getRegisteredKinds,
  getResolver,
} from "../approvals/guardian-request-resolvers.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM scoped_approval_grants");
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

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
// applyCanonicalGuardianDecision tests
// ---------------------------------------------------------------------------

describe("applyCanonicalGuardianDecision", () => {
  beforeEach(() => resetTables());

  // ── Successful approval ─────────────────────────────────────────────

  test("approves a pending tool_approval request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
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

    // Verify canonical request state
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("denies a pending tool_approval request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(false);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("denied");
  });

  test("approves a pending_question request with answer text", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "twilio",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-1",
      pendingQuestionId: "pq-1",
      questionText: "What is the gate code?",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      userText: "1234",
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.answerText).toBe("1234");
  });

  // ── Principal mismatch ──────────────────────────────────────────────

  test("rejects decision when actor principal does not match request principal", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: "wrong-principal" }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");

    // Request remains pending
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("matching principal authorizes decision (cross-channel same principal)", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
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
    // unknown_kind is not in DECISIONABLE_KINDS so it can be created without
    // guardianPrincipalId, but the decision primitive still rejects because
    // the request is missing its principal binding.
    const req = createCanonicalGuardianRequest({
      kind: "unknown_kind",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: "some-principal" }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");
  });

  test("rejects decision when actor has no guardianPrincipalId", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
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
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // First decision succeeds
    const first = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });
    expect(first.applied).toBe(true);

    // Second decision fails — request is no longer pending
    const second = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe("already_resolved");

    // First decision stuck
    const final = getCanonicalGuardianRequest(req.id);
    expect(final!.status).toBe("approved");
  });

  // ── Not found ──────────────────────────────────────────────────────

  test("returns not_found for nonexistent request", async () => {
    const result = await applyCanonicalGuardianDecision({
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
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "bogus_action" as any,
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("invalid_action");

    // Request remains pending
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  // ── approve_always downgrade ───────────────────────────────────────

  test("downgrades approve_always to approve_once", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_always",
      actorContext: guardianActor(),
    });

    // Should succeed — approve_always was silently downgraded to approve_once
    expect(result.applied).toBe(true);
    if (!result.applied) return;

    // The canonical request should be approved (not "always approved")
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");

    // Grant is not minted because the tool_approval resolver fails (no pending
    // interaction registered in the test environment). The decision primitive
    // correctly skips grant minting when the resolver reports a failure.
    expect(result.grantMinted).toBe(false);
    expect(result.resolverFailed).toBe(true);
  });

  // ── Expired request ────────────────────────────────────────────────

  test("rejects decision on expired request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // already expired
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("expired");
  });

  test("allows decision on request with no expiresAt", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      // No expiresAt
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
  });

  // ── Resolver dispatch ──────────────────────────────────────────────

  test("dispatches to tool_approval resolver", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "file_read",
      inputDigest: "sha256:def",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
  });

  test("dispatches to pending_question resolver", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "twilio",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-99",
      pendingQuestionId: "pq-99",
      questionText: "What is the password?",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      userText: "secret123",
    });

    expect(result.applied).toBe(true);
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.answerText).toBe("secret123");
  });

  test("succeeds for non-decisionable kind with matching principal", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "unknown_kind",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Should still succeed — CAS resolution happens regardless of resolver
    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("desktop actor with matching principal mints scoped grant for approved canonical request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "unknown_kind",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId: "conv-voice-1",
      callSessionId: "call-voice-1",
      toolName: "host_bash",
      inputDigest: "sha256:voice-digest-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
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
// mintCanonicalRequestGrant tests
// ---------------------------------------------------------------------------

describe("mintCanonicalRequestGrant", () => {
  beforeEach(() => resetTables());

  test("mints grant for request with tool metadata", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
    });

    const result = mintCanonicalRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
    });

    expect(result.minted).toBe(true);
  });

  test("mints grant when guardianExternalUserId is omitted", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-2",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:xyz",
    });

    const result = mintCanonicalRequestGrant({
      request: req,
      actorChannel: "vellum",
    });

    expect(result.minted).toBe(true);

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].guardianExternalUserId).toBeNull();
  });

  test("skips grant for request without tool metadata", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      // No toolName or inputDigest
    });

    const result = mintCanonicalRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
    });

    expect(result.minted).toBe(false);
  });

  test("skips grant when toolName present but inputDigest missing", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      // No inputDigest
    });

    const result = mintCanonicalRequestGrant({
      request: req,
      actorChannel: "telegram",
      guardianExternalUserId: "guardian-1",
    });

    expect(result.minted).toBe(false);
  });
});
