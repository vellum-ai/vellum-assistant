/**
 * Guard tests for canonical guardian request routing invariants.
 *
 * These tests verify that the canonical guardian request system maintains
 * its key architectural invariants:
 *
 *   1. All decision paths route through `applyCanonicalGuardianDecision`
 *   2. Principal-based authorization is enforced before decisions are applied
 *   3. Stale/expired/already-resolved decisions are rejected
 *   4. Code-only messages return clarification (not auto-approve)
 *   5. Disambiguation with multiple pending requests stays fail-closed
 *
 * The tests combine import-verification (ensuring callers reference the
 * canonical primitive) and unit tests of the router and primitive functions.
 */

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const testDir = mkdtempSync(
  join(tmpdir(), "guardian-routing-invariants-test-"),
);

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

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
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
import {
  type GuardianReplyContext,
  routeGuardianReply,
} from "../runtime/guardian-reply-router.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM scoped_approval_grants");
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
  pendingInteractions.clear();
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

function replyCtx(
  overrides: Partial<GuardianReplyContext> = {},
): GuardianReplyContext {
  return {
    messageText: "",
    channel: "telegram",
    actor: guardianActor(),
    conversationId: "conv-test",
    ...overrides,
  };
}

function registerPendingToolApprovalInteraction(
  requestId: string,
  conversationId: string,
  toolName: string = "shell",
): ReturnType<typeof mock> {
  const handleConfirmationResponse = mock(() => {});
  const mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as import("../daemon/session.js").Session;

  pendingInteractions.register(requestId, {
    session: mockSession,
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName,
      input: { command: "echo hello" },
      riskLevel: "medium",
      allowlistOptions: [
        {
          label: "echo hello",
          description: "echo hello",
          pattern: "echo hello",
        },
      ],
      scopeOptions: [
        {
          label: "everywhere",
          scope: "everywhere",
        },
      ],
    },
  });

  return handleConfirmationResponse;
}

// ===========================================================================
// SECTION 1: Import-verification guard tests
//
// These verify that all known decision entrypoints import from and call
// `applyCanonicalGuardianDecision` rather than inlining decision logic.
// ===========================================================================

describe("routing invariant: all decision paths reference applyCanonicalGuardianDecision", () => {
  const srcRoot = resolve(__dirname, "..");

  // The files that constitute decision entrypoints. Each must reference
  // `applyCanonicalGuardianDecision` (directly) or `processGuardianDecision`
  // (shared wrapper that calls applyCanonicalGuardianDecision internally).
  const DECISION_ENTRYPOINTS: Array<{
    path: string;
    symbols: string[];
  }> = [
    // Inbound channel router (Telegram/WhatsApp)
    {
      path: "runtime/guardian-reply-router.ts",
      symbols: ["applyCanonicalGuardianDecision"],
    },
    // HTTP API route handler (desktop and API clients) — uses processGuardianDecision
    // which is a shared wrapper around applyCanonicalGuardianDecision
    {
      path: "runtime/routes/guardian-action-routes.ts",
      symbols: ["processGuardianDecision"],
    },
    // Shared service where processGuardianDecision is defined — must route
    // through the canonical primitive to complete the chain:
    // entrypoint → processGuardianDecision → applyCanonicalGuardianDecision
    {
      path: "runtime/guardian-action-service.ts",
      symbols: ["applyCanonicalGuardianDecision"],
    },
  ];

  for (const { path: relPath, symbols } of DECISION_ENTRYPOINTS) {
    test(`${relPath} imports ${symbols.join(" or ")}`, () => {
      const fullPath = join(srcRoot, relPath);
      const source = readFileSync(fullPath, "utf-8");
      const found = symbols.some((s) => source.includes(s));
      expect(found).toBe(true);
    });
  }

  // The inbound message handler and session-process both use routeGuardianReply
  // which itself calls applyCanonicalGuardianDecision. Verify they reference
  // the shared router rather than inlining decision logic.
  const ROUTER_CONSUMERS = [
    "runtime/routes/inbound-message-handler.ts",
    "daemon/session-process.ts",
  ];

  for (const relPath of ROUTER_CONSUMERS) {
    test(`${relPath} uses routeGuardianReply (shared router)`, () => {
      const fullPath = join(srcRoot, relPath);
      const source = readFileSync(fullPath, "utf-8");
      expect(source).toContain("routeGuardianReply");
    });
  }

  test("daemon/session-process.ts no longer references legacy guardian-action interception", () => {
    const fullPath = join(srcRoot, "daemon/session-process.ts");
    const source = readFileSync(fullPath, "utf-8");
    expect(source).not.toContain("../memory/guardian-action-store.js");
    expect(source).not.toContain("getPendingDeliveriesByConversation");
  });

  test("daemon/session-process.ts seeds router hints via listPendingRequestsByConversationScope", () => {
    const fullPath = join(srcRoot, "daemon/session-process.ts");
    const source = readFileSync(fullPath, "utf-8");
    expect(source).toContain("listPendingRequestsByConversationScope");
  });

  test("guardian-reply-router routes all decisions through applyCanonicalGuardianDecision", () => {
    const fullPath = join(srcRoot, "runtime/guardian-reply-router.ts");
    const source = readFileSync(fullPath, "utf-8");
    // The router must import and call the canonical primitive, not applyGuardianDecision
    expect(source).toContain("applyCanonicalGuardianDecision");
    // The router must NOT directly call the legacy applyGuardianDecision
    expect(source).not.toContain("applyGuardianDecision(");
  });
});

// ===========================================================================
// SECTION 2: Principal-based authorization invariants
// ===========================================================================

describe("routing invariant: principal-based authorization enforced before decisions", () => {
  beforeEach(() => resetTables());

  test("mismatching actor principal is rejected by canonical primitive", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({ guardianPrincipalId: "wrong-principal" }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");

    // Request must remain pending (no state change)
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("matching principal authorizes desktop actor", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: trustedActor(),
    });

    expect(result.applied).toBe(true);
  });

  test("actor without guardianPrincipalId is rejected", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
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

  test("principal mismatch on code-only message blocks detail leakage", async () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "ABC123",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "ABC123",
        actor: guardianActor({ guardianPrincipalId: "wrong-principal" }),
        conversationId: "conv-1",
      }),
    );

    // Code-only clarification should be returned but must NOT reveal tool details
    expect(result.consumed).toBe(true);
    expect(result.type).toBe("code_only_clarification");
    expect(result.replyText).toBe("Request not found.");
    expect(result.decisionApplied).toBe(false);
  });
});

// ===========================================================================
// SECTION 3: Stale / expired / already-resolved rejection
// ===========================================================================

describe("routing invariant: stale/expired/already-resolved decisions rejected", () => {
  beforeEach(() => resetTables());

  test("expired request is rejected by canonical primitive", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() - 10_000, // already expired
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

  test("already-resolved request is rejected (first-writer-wins)", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
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

  test("nonexistent request returns not_found", async () => {
    const result = await applyCanonicalGuardianDecision({
      requestId: "nonexistent-id",
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("not_found");
  });

  test("already-resolved request via router returns not_consumed (code lookup filters pending only)", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "ABC123",
      expiresAt: Date.now() + 60_000,
    });

    // Resolve the request first
    await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    // Attempt to resolve again via router with code prefix.
    // Since getCanonicalGuardianRequestByCode only returns pending requests,
    // the resolved request won't be found and the code won't match.
    const result = await routeGuardianReply(
      replyCtx({
        messageText: "ABC123 approve",
        conversationId: "conv-1",
      }),
    );

    // Code lookup filters by status='pending', so the resolved request is invisible.
    // The router does not match the code and returns not_consumed.
    expect(result.consumed).toBe(false);
  });

  test("expired request via callback returns stale type", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() - 10_000, // already expired
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "",
        callbackData: `apr:${req.id}:approve_once`,
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_stale");
    expect(result.decisionApplied).toBe(false);
  });
});

// ===========================================================================
// SECTION 4: Code-only messages return clarification, not auto-approve
// ===========================================================================

describe("routing invariant: code-only messages return clarification", () => {
  beforeEach(() => resetTables());

  test("code-only message returns clarification with request details", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "A1B2C3",
      toolName: "shell",
      questionText: "Run shell command: ls -la",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "A1B2C3",
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("code_only_clarification");
    expect(result.decisionApplied).toBe(false);
    // Must provide actionable instructions
    expect(result.replyText).toContain("A1B2C3");
    expect(result.replyText).toContain("approve");
    expect(result.replyText).toContain("reject");

    // The request must remain pending — NOT auto-approved
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("code-only pending_question asks for free-text answer (not approve/reject)", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-1",
      pendingQuestionId: "pq-1",
      requestCode: "A2B3C4",
      questionText: "What time works best?",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "A2B3C4",
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("code_only_clarification");
    expect(result.decisionApplied).toBe(false);
    expect(result.replyText).toContain("A2B3C4");
    expect(result.replyText).toContain("<your answer>");
    expect(result.replyText).not.toContain("approve");
    expect(result.replyText).not.toContain("reject");

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("code-only tool-backed pending_question asks for approve/reject decision", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-2",
      pendingQuestionId: "pq-2",
      requestCode: "B2C3D4",
      questionText: "Allow send_email to bob@example.com?",
      toolName: "send_email",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "B2C3D4",
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("code_only_clarification");
    expect(result.decisionApplied).toBe(false);
    expect(result.replyText).toContain("B2C3D4");
    expect(result.replyText).toContain("approve");
    expect(result.replyText).toContain("reject");
    expect(result.replyText).not.toContain("<your answer>");

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("code with decision text does apply the decision", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "A1B2C3",
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "A1B2C3 approve",
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("code with reject text denies the request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "D4E5F6",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "D4E5F6 reject",
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("denied");
  });
});

// ===========================================================================
// SECTION 5: Disambiguation with multiple pending requests stays fail-closed
// ===========================================================================

describe("routing invariant: disambiguation stays fail-closed", () => {
  beforeEach(() => resetTables());

  test("single hinted pending request accepts explicit plain-text approve without NL generator", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "DDD444",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("single hinted pending request does not auto-approve broad acknowledgment text", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "GGG777",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "ok, what is this for?",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(result.decisionApplied).toBe(false);

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("explicit empty pendingRequestIds hint stays fail-closed for desktop actors", async () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-other",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "HHH888",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        actor: trustedActor(),
        conversationId: "conv-unrelated",
        pendingRequestIds: [],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(result.decisionApplied).toBe(false);
  });

  test("multiple hinted pending requests with plain-text approve returns disambiguation", async () => {
    const req1 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "EEE555",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    const req2 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "FFF666",
      toolName: "file_write",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req1.id, req2.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("disambiguation_needed");
    expect(result.decisionApplied).toBe(false);
    expect(result.replyText).toContain("EEE555");
    expect(result.replyText).toContain("FFF666");

    const r1 = getCanonicalGuardianRequest(req1.id);
    const r2 = getCanonicalGuardianRequest(req2.id);
    expect(r1!.status).toBe("pending");
    expect(r2!.status).toBe("pending");
  });

  test("multiple pending requests without target return disambiguation (not auto-resolve)", async () => {
    // Create two pending requests for the same guardian
    const req1 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "AAA111",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    const req2 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "BBB222",
      toolName: "file_write",
      expiresAt: Date.now() + 60_000,
    });

    // The NL engine mock: returns a decision but no specific target.
    // This simulates a guardian saying "yes" without specifying which request.
    const mockGenerator = async () => ({
      disposition: "approve_once" as const,
      replyText: "Approved!",
      targetRequestId: undefined,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "yes approve it",
        conversationId: "conv-1",
        pendingRequestIds: [req1.id, req2.id],
        approvalConversationGenerator: mockGenerator as any,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("disambiguation_needed");
    expect(result.decisionApplied).toBe(false);

    // Both requests must remain pending — fail-closed
    const r1 = getCanonicalGuardianRequest(req1.id);
    const r2 = getCanonicalGuardianRequest(req2.id);
    expect(r1!.status).toBe("pending");
    expect(r2!.status).toBe("pending");

    // Disambiguation reply should list request codes
    expect(result.replyText).toContain("AAA111");
    expect(result.replyText).toContain("BBB222");
  });

  test("disambiguation treats tool-backed pending_question as approval request", async () => {
    const answerRequest = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-answer",
      pendingQuestionId: "pq-answer",
      requestCode: "ABC123",
      questionText: "What time works best?",
      expiresAt: Date.now() + 60_000,
    });

    const approvalRequest = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      callSessionId: "call-approval",
      pendingQuestionId: "pq-approval",
      requestCode: "DEF456",
      questionText: "Allow send_email to bob@example.com?",
      toolName: "send_email",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [answerRequest.id, approvalRequest.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("disambiguation_needed");
    expect(result.decisionApplied).toBe(false);
    expect(result.replyText).toContain("ABC123");
    expect(result.replyText).toContain("DEF456");
    expect(result.replyText).toContain("send_email");
    expect(result.replyText).toContain(
      'For questions: reply "ABC123 <your answer>".',
    );
    expect(result.replyText).toContain(
      'For approvals: reply "DEF456 approve" or "DEF456 reject".',
    );
  });

  test("single pending request does not need disambiguation", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "CCC333",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    // NL engine returns a decision without specifying target — but only one
    // request is pending, so it should be resolved without disambiguation.
    const mockGenerator = async () => ({
      disposition: "approve_once" as const,
      replyText: "Approved!",
      targetRequestId: undefined,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "yes",
        conversationId: "conv-1",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: mockGenerator as any,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test('single pending request accepts "go for it" as deterministic approval', async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      requestCode: "GO1234",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "go for it",
        conversationId: "conv-1",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("code-based routing is constrained to caller-provided pendingRequestIds scope", async () => {
    const inScope = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "111AAA",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });
    const outOfScope = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-2",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "222BBB",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(inScope.id, "conv-1", "shell");
    registerPendingToolApprovalInteraction(outOfScope.id, "conv-2", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "222BBB approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [inScope.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(result.decisionApplied).toBe(false);

    const inScopeAfter = getCanonicalGuardianRequest(inScope.id);
    const outOfScopeAfter = getCanonicalGuardianRequest(outOfScope.id);
    expect(inScopeAfter!.status).toBe("pending");
    expect(outOfScopeAfter!.status).toBe("pending");
  });
});

// ===========================================================================
// SECTION 6: Resolver registry integrity
// ===========================================================================

describe("routing invariant: resolver registry covers all built-in kinds", () => {
  test("tool_approval resolver is registered", () => {
    const resolver = getResolver("tool_approval");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("tool_approval");
  });

  test("pending_question resolver is registered", () => {
    const resolver = getResolver("pending_question");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("pending_question");
  });

  test("unknown kind returns undefined (no default fallback)", () => {
    expect(getResolver("nonexistent_kind")).toBeUndefined();
  });

  test("registered kinds include at least tool_approval and pending_question", () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain("tool_approval");
    expect(kinds).toContain("pending_question");
  });
});

// ===========================================================================
// SECTION 7: approve_always downgrade invariant
// ===========================================================================

describe("routing invariant: approve_always downgraded for guardian-on-behalf", () => {
  beforeEach(() => resetTables());

  test("approve_always is silently downgraded to approve_once by canonical primitive", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_always",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);

    // Status should be 'approved' (not some 'always_approved' state)
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });
});

// ===========================================================================
// SECTION 8: Callback routing uses applyCanonicalGuardianDecision
// ===========================================================================

describe("routing invariant: callback buttons route through canonical primitive", () => {
  beforeEach(() => resetTables());

  test("valid callback data applies decision via canonical primitive", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      toolName: "shell",
      inputDigest: "sha256:abc",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "",
        callbackData: `apr:${req.id}:approve_once`,
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("callback with reject action denies the request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-1", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "",
        callbackData: `apr:${req.id}:reject`,
        conversationId: "conv-1",
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("denied");
  });

  test("callback targeting different conversation is still processed (conversationId scoping removed for cross-channel)", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-other",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-other", "shell");

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "",
        callbackData: `apr:${req.id}:approve_once`,
        conversationId: "conv-1", // different conversation — no longer rejected
      }),
    );

    // Should be consumed — conversationId scoping was removed because in
    // cross-channel flows the guardian's conversation differs from the
    // requester's. Principal validation in the canonical decision primitive
    // is the correct security boundary.
    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    // Request should be approved
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });
});

// ===========================================================================
// SECTION 9: Destination hints do not bypass principal binding for tool_approval
// ===========================================================================

describe("routing invariant: destination hints do not bypass tool_approval principal binding", () => {
  beforeEach(() => resetTables());

  test("explicit pendingRequestIds still fail closed when guardianPrincipalId does not match", async () => {
    // Voice-originated tool approval with a different principal than the actor.
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "twilio",
      conversationId: "conv-voice-1",
      toolName: "shell",
      requestCode: "NL1234",
      guardianPrincipalId: "request-principal",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(req.id, "conv-voice-1", "shell");

    // The channel inbound router would compute pendingRequestIds from
    // delivery-scoped lookup and pass them here. Simulate that.
    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        channel: "telegram",
        actor: guardianActor({ guardianPrincipalId: "different-principal" }),
        conversationId: "conv-guardian-chat",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_stale");
    expect(result.decisionApplied).toBe(false);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("pending");
  });

  test("without destination hints, unbound principal means no pending requests found", async () => {
    // Voice-originated request: different principal
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "twilio",
      conversationId: "conv-voice-2",
      toolName: "shell",
      requestCode: "NL5678",
      guardianPrincipalId: "voice-principal",
      expiresAt: Date.now() + 60_000,
    });

    // No pendingRequestIds passed — identity-based fallback uses
    // actor.actorExternalUserId which does not match any request's
    // guardianExternalUserId (since it's null).
    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        channel: "telegram",
        actor: guardianActor({ actorExternalUserId: "guardian-tg-user" }),
        conversationId: "conv-guardian-chat",
        // pendingRequestIds: undefined — no delivery hints
        approvalConversationGenerator: undefined,
      }),
    );

    // Identity-based lookup finds nothing because the request has no
    // guardianExternalUserId, so the router returns not_consumed.
    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });
});

// ===========================================================================
// SECTION 10: Invite handoff bypass for access requests
// ===========================================================================

describe("routing invariant: invite handoff bypass for access requests", () => {
  beforeEach(() => resetTables());

  test('pending access_request + message "open invite flow" returns not_consumed with skipApprovalInterception', async () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-access-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "INV001",
      toolName: "ingress_access_request",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "open invite flow",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(result.decisionApplied).toBe(false);
    expect(result.skipApprovalInterception).toBe(true);

    // Request remains pending — not resolved by the handoff
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("invite handoff is case-insensitive and punctuation-trimmed", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      expiresAt: Date.now() + 60_000,
    });

    for (const phrase of [
      "Open Invite Flow",
      "OPEN INVITE FLOW",
      "open invite flow.",
      "Open invite flow!",
    ]) {
      const result = await routeGuardianReply(
        replyCtx({
          messageText: phrase,
          conversationId: "conv-test",
          pendingRequestIds: [req.id],
          approvalConversationGenerator: undefined,
        }),
      );

      expect(result.consumed).toBe(false);
      expect(result.type).toBe("not_consumed");
    }
  });

  test("invite handoff does NOT bypass for non-access-request kinds", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "TAP001",
      toolName: "shell",
      expiresAt: Date.now() + 60_000,
    });

    await routeGuardianReply(
      replyCtx({
        messageText: "open invite flow",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    // Should NOT return not_consumed via the invite handoff path.
    // Without NL generator and no explicit approve/reject, it falls through
    // to not_consumed anyway, but the key invariant is the request remains pending.
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("explicit approve/reject messages still consume with pending access_request", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-access-2",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "A00B01",
      toolName: "ingress_access_request",
      expiresAt: Date.now() + 60_000,
    });

    // Code-based approve should still work (request code must be valid hex: [A-F0-9]{6})
    const result = await routeGuardianReply(
      replyCtx({
        messageText: "A00B01 approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [req.id],
        approvalConversationGenerator: undefined,
      }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("desktop access-request approval returns a verification code reply", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-access-desktop",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "C0D3A5",
      toolName: "ingress_access_request",
      expiresAt: Date.now() + 60_000,
    });

    const result = await routeGuardianReply({
      messageText: "C0D3A5 approve",
      channel: "vellum",
      actor: trustedActor({ channel: "vellum" }),
      conversationId: "conv-guardian-conversation",
      pendingRequestIds: [req.id],
      approvalConversationGenerator: undefined,
    });

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);
    expect(result.replyText).toContain("verification code");
    expect(result.replyText).toMatch(/\b\d{6}\b/);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });

  test("NL decision path preserves resolver verification code reply text", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-access-desktop-nl",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requesterExternalUserId: "requester-1",
      requesterChatId: "chat-1",
      requestCode: "A1B2C3",
      toolName: "ingress_access_request",
      expiresAt: Date.now() + 60_000,
    });

    const approvalConversationGenerator = async () => ({
      disposition: "approve_once" as const,
      replyText: "Access approved.",
      targetRequestId: req.id,
    });

    const result = await routeGuardianReply({
      messageText: "please approve this request",
      channel: "vellum",
      actor: trustedActor({ channel: "vellum" }),
      conversationId: "conv-guardian-conversation",
      pendingRequestIds: [req.id],
      approvalConversationGenerator: approvalConversationGenerator as any,
    });

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(result.replyText).toContain("verification code");
    expect(result.replyText).toMatch(/\b\d{6}\b/);
    expect(result.replyText).not.toBe("Access approved.");

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
  });
});

// ===========================================================================
// SECTION 11: Expired requests are excluded from routing
// ===========================================================================

describe("routing invariant: expired requests are excluded from pending discovery", () => {
  beforeEach(() => resetTables());

  test("expired request with hinted IDs is excluded from disambiguation", async () => {
    const expired = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "EXP001",
      toolName: "shell",
      expiresAt: Date.now() - 10_000,
    });

    const active = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "ACT001",
      toolName: "file_write",
      expiresAt: Date.now() + 60_000,
    });
    registerPendingToolApprovalInteraction(active.id, "conv-1", "file_write");

    // Both IDs are hinted but only the active one should be considered
    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [expired.id, active.id],
        approvalConversationGenerator: undefined,
      }),
    );

    // Single active request — should apply directly, no disambiguation
    expect(result.consumed).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(result.decisionApplied).toBe(true);

    const resolvedActive = getCanonicalGuardianRequest(active.id);
    expect(resolvedActive!.status).toBe("approved");

    // Expired request untouched
    const resolvedExpired = getCanonicalGuardianRequest(expired.id);
    expect(resolvedExpired!.status).toBe("pending");
  });

  test("all expired hinted requests means no pending found — not consumed", async () => {
    const expired1 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "EXP002",
      toolName: "shell",
      expiresAt: Date.now() - 10_000,
    });

    const expired2 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      conversationId: "conv-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      requestCode: "EXP003",
      toolName: "file_write",
      expiresAt: Date.now() - 5_000,
    });

    const result = await routeGuardianReply(
      replyCtx({
        messageText: "approve",
        conversationId: "conv-guardian-conversation",
        pendingRequestIds: [expired1.id, expired2.id],
        approvalConversationGenerator: undefined,
      }),
    );

    // No active pending requests — falls through
    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(result.decisionApplied).toBe(false);
  });
});
