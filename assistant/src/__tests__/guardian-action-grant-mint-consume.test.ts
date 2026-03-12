/**
 * Integration test: guardian-action answer resolution mints a scoped grant
 * that the voice consumer can consume exactly once.
 *
 * Exercises the original voice bug scenario end-to-end:
 *   1. Voice ASK_GUARDIAN fires -> guardian action request created with tool metadata
 *   2. Guardian answers via desktop/Telegram -> request resolved
 *   3. tryMintGuardianActionGrant mints a tool_signature grant
 *   4. Voice consumer can consume the grant for the same tool+input
 *   5. Second consume attempt is denied (one-time use)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "guardian-action-grant-e2e-"));

// ── Platform + logger mocks ─────────────────────────────────────────

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

// ── Imports (after mocks) ───────────────────────────────────────────

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createGuardianActionRequest,
  resolveGuardianActionRequest,
} from "../memory/guardian-action-store.js";
import { conversations, scopedApprovalGrants } from "../memory/schema.js";
import { _internal } from "../memory/scoped-approval-grants.js";

const { consumeScopedApprovalGrantByToolSignature } = _internal;
import { tryMintGuardianActionGrant } from "../runtime/guardian-action-grant-minter.js";
import type { ApprovalConversationGenerator } from "../runtime/http-types.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Constants ───────────────────────────────────────────────────────

const TOOL_NAME = "execute_shell";
const TOOL_INPUT = { command: "rm -rf /tmp/test" };
const CONVERSATION_ID = "conv-e2e";

// Mutable references populated by ensureFkParents()
let CALL_SESSION_ID = "";
let PENDING_QUESTION_IDS: string[] = [];
let pqIndex = 0;

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Create the FK parent rows required by guardian_action_requests. */
function ensureFkParents(): void {
  ensureConversation(CONVERSATION_ID);
  const session = createCallSession({
    conversationId: CONVERSATION_ID,
    provider: "twilio",
    fromNumber: "+15550001111",
    toNumber: "+15550002222",
  });
  CALL_SESSION_ID = session.id;

  // Pre-create enough pending questions for all tests in a suite run
  PENDING_QUESTION_IDS = [];
  pqIndex = 0;
  for (let i = 0; i < 20; i++) {
    const pq = createPendingQuestion(session.id, `Question ${i}`);
    PENDING_QUESTION_IDS.push(pq.id);
  }
}

function nextPendingQuestionId(): string {
  return PENDING_QUESTION_IDS[pqIndex++];
}

function clearTables(): void {
  const db = getDb();
  try {
    db.run("DELETE FROM scoped_approval_grants");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM guardian_action_deliveries");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM guardian_action_requests");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM call_pending_questions");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM call_events");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM call_sessions");
  } catch {
    /* table may not exist */
  }
  try {
    db.run("DELETE FROM conversations");
  } catch {
    /* table may not exist */
  }
}

// ── Shared mock generators ──────────────────────────────────────────

const approveOnceGenerator: ApprovalConversationGenerator = async () => ({
  disposition: "approve_once",
  replyText: "Approved.",
});

const rejectGenerator: ApprovalConversationGenerator = async () => ({
  disposition: "reject",
  replyText: "Denied.",
});

const keepPendingGenerator: ApprovalConversationGenerator = async () => ({
  disposition: "keep_pending",
  replyText: "Could you clarify?",
});

// ── Tests ───────────────────────────────────────────────────────────

describe("guardian-action grant mint -> voice consume integration", () => {
  beforeEach(() => {
    clearTables();
    ensureFkParents();
  });

  test("full flow: resolve guardian action with tool metadata -> mint grant -> voice consume succeeds once", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    // Step 1: Create a guardian action request with tool metadata
    // (simulates the voice ASK_GUARDIAN path)
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run rm -rf /tmp/test?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    expect(request.toolName).toBe(TOOL_NAME);
    expect(request.inputDigest).toBe(inputDigest);
    expect(request.status).toBe("pending");

    // Step 2: Guardian answers -> resolve the request
    const resolved = resolveGuardianActionRequest(
      request.id,
      "yes",
      "telegram",
      "guardian-user-123",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("answered");

    // Step 3: Mint a scoped grant from the resolved request
    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "yes",
      decisionChannel: "telegram",
      guardianExternalUserId: "guardian-user-123",
      approvalConversationGenerator: approveOnceGenerator,
    });

    // Verify the grant was created
    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].toolName).toBe(TOOL_NAME);
    expect(grants[0].inputDigest).toBe(inputDigest);
    expect(grants[0].scopeMode).toBe("tool_signature");
    expect(grants[0].status).toBe("active");
    expect(grants[0].callSessionId).toBe(CALL_SESSION_ID);

    // Step 4: Voice consumer consumes the grant
    const consumeResult = consumeScopedApprovalGrantByToolSignature({
      toolName: TOOL_NAME,
      inputDigest,
      consumingRequestId: "voice-req-1",
      executionChannel: "phone",
      callSessionId: CALL_SESSION_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(consumeResult.ok).toBe(true);
    expect(consumeResult.grant).not.toBeNull();
    expect(consumeResult.grant!.status).toBe("consumed");
    expect(consumeResult.grant!.consumedByRequestId).toBe("voice-req-1");

    // Step 5: Second consume attempt fails (one-time use)
    const secondConsume = consumeScopedApprovalGrantByToolSignature({
      toolName: TOOL_NAME,
      inputDigest,
      consumingRequestId: "voice-req-2",
      executionChannel: "phone",
      callSessionId: CALL_SESSION_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(secondConsume.ok).toBe(false);
    expect(secondConsume.grant).toBeNull();
  });

  test("no grant minted when guardian action request lacks tool metadata", async () => {
    // Create a request without toolName/inputDigest (informational consult)
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "What should I tell the caller?",
      expiresAt: Date.now() + 60_000,
      // No toolName or inputDigest
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "Tell them to call back",
      "vellum",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "Tell them to call back",
      decisionChannel: "vellum",
      approvalConversationGenerator: approveOnceGenerator,
    });

    // No grant should have been created
    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });

  test("grant minted via desktop/vellum channel also consumable by voice", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Permission to execute?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    // Guardian answers via desktop (vellum channel)
    const resolved = resolveGuardianActionRequest(
      request.id,
      "approve",
      "vellum",
    );
    expect(resolved).not.toBeNull();

    // Mint with decisionChannel: 'vellum' (desktop path)
    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "approve",
      decisionChannel: "vellum",
      approvalConversationGenerator: approveOnceGenerator,
    });

    // The grant should have executionChannel: null (wildcard), so voice can consume
    const consumeResult = consumeScopedApprovalGrantByToolSignature({
      toolName: TOOL_NAME,
      inputDigest,
      consumingRequestId: "voice-req-desktop",
      executionChannel: "phone",
      callSessionId: CALL_SESSION_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(consumeResult.ok).toBe(true);
  });

  test("no grant minted when guardian answer is a denial", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run rm -rf /tmp/test?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    // Guardian explicitly denies the action
    const resolved = resolveGuardianActionRequest(
      request.id,
      "No",
      "telegram",
      "guardian-user-456",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "No",
      decisionChannel: "telegram",
      guardianExternalUserId: "guardian-user-456",
      approvalConversationGenerator: rejectGenerator,
    });

    // No grant should have been created for a denial
    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });

  test("no grant minted when classifier returns reject", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Permission to execute?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "deny",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "deny",
      decisionChannel: "telegram",
      approvalConversationGenerator: rejectGenerator,
    });

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conversational engine classification tests
// ---------------------------------------------------------------------------

describe("guardian-action grant minter: conversational engine classification", () => {
  beforeEach(() => {
    clearTables();
    ensureFkParents();
  });

  test("approval via conversational engine mints a grant", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run the command?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "yes",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "yes",
      decisionChannel: "telegram",
      approvalConversationGenerator: approveOnceGenerator,
    });

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].toolName).toBe(TOOL_NAME);
  });

  test("free-form approval via conversational engine mints a grant", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run the command?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "Sure, go ahead and run it",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "Sure, go ahead and run it",
      decisionChannel: "telegram",
      approvalConversationGenerator: approveOnceGenerator,
    });

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(1);
    expect(grants[0].toolName).toBe(TOOL_NAME);
  });

  test("ambiguous text returns keep_pending from generator, no grant minted", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run the command?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "I'm not sure about this",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "I'm not sure about this",
      decisionChannel: "telegram",
      approvalConversationGenerator: keepPendingGenerator,
    });

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });

  test("generator failure falls back to no grant (fail-closed)", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run the command?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "Sure, go ahead and run it",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    const failingGenerator: ApprovalConversationGenerator = async () => {
      throw new Error("LLM provider unavailable");
    };

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "Sure, go ahead and run it",
      decisionChannel: "telegram",
      approvalConversationGenerator: failingGenerator,
    });

    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });

  test("allowedActions excludes approve_always (guardian invariant)", async () => {
    const inputDigest = computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT);

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      pendingQuestionId: nextPendingQuestionId(),
      questionText: "Can I run the command?",
      expiresAt: Date.now() + 60_000,
      toolName: TOOL_NAME,
      inputDigest,
    });

    const resolved = resolveGuardianActionRequest(
      request.id,
      "Sure, go ahead and run it",
      "telegram",
    );
    expect(resolved).not.toBeNull();

    // Generator returns approve_always -- but the allowedActions constraint
    // in the minter restricts to approve_once/reject, so the approval-
    // conversation-turn layer will normalize this to keep_pending.
    const mockGenerator: ApprovalConversationGenerator = async () => ({
      disposition: "approve_always",
      replyText: "Approved permanently.",
    });

    await tryMintGuardianActionGrant({
      request: resolved!,
      answerText: "Sure, go ahead and run it",
      decisionChannel: "telegram",
      approvalConversationGenerator: mockGenerator,
    });

    // No grant -- approve_always is not in allowedActions,
    // so the disposition gets normalized to keep_pending (fail-closed).
    const db = getDb();
    const grants = db.select().from(scopedApprovalGrants).all();
    expect(grants.length).toBe(0);
  });
});
