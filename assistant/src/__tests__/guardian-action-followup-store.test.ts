import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "guardian-action-followup-test-"));

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
}));

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createGuardianActionRequest,
  expireGuardianActionRequest,
  finalizeFollowup,
  getGuardianActionRequest,
  markTimedOutWithReason,
  progressFollowupState,
  resolveGuardianActionRequest,
  startFollowupFromExpiredRequest,
} from "../memory/guardian-action-store.js";
import { conversations } from "../memory/schema.js";

initializeDb();

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

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createTestRequest(convId: string) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: "twilio",
    fromNumber: "+15550001111",
    toNumber: "+15550002222",
  });
  const pq = createPendingQuestion(session.id, "What is the gate code?");
  return createGuardianActionRequest({
    kind: "ask_guardian",
    sourceChannel: "phone",
    sourceConversationId: convId,
    callSessionId: session.id,
    pendingQuestionId: pq.id,
    questionText: pq.questionText,
    expiresAt: Date.now() + 60_000,
  });
}

describe("guardian-action-followup-store", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  // ── markTimedOutWithReason ──────────────────────────────────────────

  test("markTimedOutWithReason sets expired_reason correctly for call_timeout", () => {
    const request = createTestRequest("conv-followup-1");
    const result = markTimedOutWithReason(request.id, "call_timeout");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("expired");
    expect(result!.expiredReason).toBe("call_timeout");
  });

  test("markTimedOutWithReason sets expired_reason correctly for sweep_timeout", () => {
    const request = createTestRequest("conv-followup-2");
    const result = markTimedOutWithReason(request.id, "sweep_timeout");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("expired");
    expect(result!.expiredReason).toBe("sweep_timeout");
  });

  test("markTimedOutWithReason returns null for already-expired request", () => {
    const request = createTestRequest("conv-followup-3");

    // First call succeeds
    const first = markTimedOutWithReason(request.id, "call_timeout");
    expect(first).not.toBeNull();

    // Second call returns null (already expired)
    const second = markTimedOutWithReason(request.id, "sweep_timeout");
    expect(second).toBeNull();

    // Verify the original reason is preserved
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.expiredReason).toBe("call_timeout");
  });

  test("markTimedOutWithReason returns null for answered request", () => {
    const request = createTestRequest("conv-followup-4");
    resolveGuardianActionRequest(request.id, "The code is 1234", "telegram");

    const result = markTimedOutWithReason(request.id, "call_timeout");
    expect(result).toBeNull();
  });

  // ── startFollowupFromExpiredRequest ─────────────────────────────────

  test("startFollowupFromExpiredRequest transitions correctly", () => {
    const request = createTestRequest("conv-followup-5");
    markTimedOutWithReason(request.id, "call_timeout");

    const result = startFollowupFromExpiredRequest(
      request.id,
      "The code is 5678",
    );
    expect(result).not.toBeNull();
    expect(result!.followupState).toBe("awaiting_guardian_choice");
    expect(result!.lateAnswerText).toBe("The code is 5678");
    expect(result!.lateAnsweredAt).toBeGreaterThan(0);
  });

  test("startFollowupFromExpiredRequest rejects pending request", () => {
    const request = createTestRequest("conv-followup-6");

    const result = startFollowupFromExpiredRequest(request.id, "Late answer");
    expect(result).toBeNull();

    // Verify followup_state unchanged
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("none");
  });

  test("startFollowupFromExpiredRequest rejects answered request", () => {
    const request = createTestRequest("conv-followup-7");
    resolveGuardianActionRequest(request.id, "Original answer", "telegram");

    const result = startFollowupFromExpiredRequest(request.id, "Late answer");
    expect(result).toBeNull();
  });

  test("startFollowupFromExpiredRequest rejects already-in-followup request", () => {
    const request = createTestRequest("conv-followup-8");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "First late answer");

    // Second attempt should fail
    const result = startFollowupFromExpiredRequest(
      request.id,
      "Another late answer",
    );
    expect(result).toBeNull();

    // Verify original late answer preserved
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.lateAnswerText).toBe("First late answer");
  });

  // ── progressFollowupState ───────────────────────────────────────────

  test("progressFollowupState valid transition: awaiting_guardian_choice -> dispatching", () => {
    const request = createTestRequest("conv-followup-9");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");

    const result = progressFollowupState(
      request.id,
      "dispatching",
      "call_back",
    );
    expect(result).not.toBeNull();
    expect(result!.followupState).toBe("dispatching");
    expect(result!.followupAction).toBe("call_back");
  });

  test("progressFollowupState rejects terminal transition: awaiting_guardian_choice -> declined", () => {
    const request = createTestRequest("conv-followup-10");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");

    // Terminal transitions must go through finalizeFollowup, not progressFollowupState
    const result = progressFollowupState(request.id, "declined", "decline");
    expect(result).toBeNull();

    // Verify state unchanged
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("awaiting_guardian_choice");
  });

  test("progressFollowupState rejects invalid transition: none -> dispatching", () => {
    const request = createTestRequest("conv-followup-11");
    markTimedOutWithReason(request.id, "call_timeout");

    // followup_state is 'none', cannot jump to 'dispatching'
    const result = progressFollowupState(request.id, "dispatching");
    expect(result).toBeNull();
  });

  test("progressFollowupState rejects invalid transition: dispatching -> awaiting_guardian_choice", () => {
    const request = createTestRequest("conv-followup-12");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");
    progressFollowupState(request.id, "dispatching", "call_back");

    // Cannot go back to awaiting_guardian_choice
    const result = progressFollowupState(
      request.id,
      "awaiting_guardian_choice",
    );
    expect(result).toBeNull();
  });

  test("progressFollowupState rejects transition from terminal state", () => {
    const request = createTestRequest("conv-followup-13");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");
    progressFollowupState(request.id, "dispatching", "call_back");
    finalizeFollowup(request.id, "completed");

    // completed is terminal — progressFollowupState cannot leave it
    const result = progressFollowupState(request.id, "dispatching");
    expect(result).toBeNull();
  });

  test("progressFollowupState rejects none -> awaiting_guardian_choice even on expired request", () => {
    const request = createTestRequest("conv-followup-13b");
    markTimedOutWithReason(request.id, "call_timeout");

    // none -> awaiting_guardian_choice must only go through startFollowupFromExpiredRequest
    // (which atomically sets lateAnswerText and lateAnsweredAt)
    const result = progressFollowupState(
      request.id,
      "awaiting_guardian_choice",
    );
    expect(result).toBeNull();

    // Verify followup_state unchanged
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("none");
    expect(reloaded!.status).toBe("expired");
  });

  test("progressFollowupState rejects non-expired request", () => {
    const request = createTestRequest("conv-followup-13c");

    // Request is still 'pending', not 'expired' — follow-up transitions must not apply
    const result = progressFollowupState(
      request.id,
      "awaiting_guardian_choice",
    );
    expect(result).toBeNull();

    // Verify followup_state unchanged
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("none");
    expect(reloaded!.status).toBe("pending");
  });

  // ── finalizeFollowup ────────────────────────────────────────────────

  test("finalizeFollowup sets followup_completed_at for completed", () => {
    const request = createTestRequest("conv-followup-14");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");
    progressFollowupState(request.id, "dispatching", "call_back");

    const result = finalizeFollowup(request.id, "completed");
    expect(result).not.toBeNull();
    expect(result!.followupState).toBe("completed");
    expect(result!.followupCompletedAt).toBeGreaterThan(0);
  });

  test("finalizeFollowup sets followup_completed_at for failed", () => {
    const request = createTestRequest("conv-followup-15");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");
    progressFollowupState(request.id, "dispatching", "call_back");

    const result = finalizeFollowup(request.id, "failed");
    expect(result).not.toBeNull();
    expect(result!.followupState).toBe("failed");
    expect(result!.followupCompletedAt).toBeGreaterThan(0);
  });

  test("finalizeFollowup with declined from awaiting_guardian_choice", () => {
    const request = createTestRequest("conv-followup-16");
    markTimedOutWithReason(request.id, "call_timeout");
    startFollowupFromExpiredRequest(request.id, "Late answer");

    const result = finalizeFollowup(request.id, "declined");
    expect(result).not.toBeNull();
    expect(result!.followupState).toBe("declined");
    expect(result!.followupCompletedAt).toBeGreaterThan(0);
  });

  test("finalizeFollowup rejects invalid transition from none", () => {
    const request = createTestRequest("conv-followup-17");
    markTimedOutWithReason(request.id, "call_timeout");

    // followup_state is 'none', cannot finalize
    const result = finalizeFollowup(request.id, "completed");
    expect(result).toBeNull();
  });

  test("finalizeFollowup rejects non-expired request", () => {
    const request = createTestRequest("conv-followup-17b");

    // Request is still 'pending', not 'expired' — finalize must not apply
    const result = finalizeFollowup(request.id, "completed");
    expect(result).toBeNull();

    // Verify followup_state unchanged
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("none");
    expect(reloaded!.status).toBe("pending");
  });

  // ── Existing behavior preserved ─────────────────────────────────────

  test("resolve/expire behavior unchanged: resolveGuardianActionRequest still works", () => {
    const request = createTestRequest("conv-followup-18");

    const resolved = resolveGuardianActionRequest(
      request.id,
      "Answer here",
      "telegram",
      "user-1",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("answered");
    expect(resolved!.answerText).toBe("Answer here");
    // Follow-up fields remain at defaults
    expect(resolved!.followupState).toBe("none");
    expect(resolved!.expiredReason).toBeNull();
  });

  test("expireGuardianActionRequest sets explicit reason", () => {
    const request = createTestRequest("conv-followup-19");

    expireGuardianActionRequest(request.id, "call_timeout");

    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.status).toBe("expired");
    expect(reloaded!.expiredReason).toBe("call_timeout");
  });

  test("new fields default correctly on freshly created request", () => {
    const request = createTestRequest("conv-followup-21");

    expect(request.expiredReason).toBeNull();
    expect(request.followupState).toBe("none");
    expect(request.lateAnswerText).toBeNull();
    expect(request.lateAnsweredAt).toBeNull();
    expect(request.followupAction).toBeNull();
    expect(request.followupCompletedAt).toBeNull();
  });
});
