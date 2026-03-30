import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  clearActiveCallLeases,
  listActiveCallLeases,
  upsertActiveCallLease,
} from "../calls/active-call-lease.js";
import {
  logDeadLetterEvent,
  NO_SID_GRACE_PERIOD_MS,
  reconcileCallsOnStartup,
} from "../calls/call-recovery.js";
import {
  createCallSession,
  createPendingQuestion,
  getCallSession,
  getPendingQuestion,
  listRecoverableCalls,
  updateCallSession,
} from "../calls/call-store.js";
import type { VoiceProvider } from "../calls/voice-provider.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";

initializeDb();

afterAll(() => {
  resetDb();
});

/** Ensure a conversation row exists for the given ID so FK constraints pass. */
let ensuredConvIds = new Set<string>();
function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Test conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  ensuredConvIds = new Set();
}

function createTestCallSession(opts: Parameters<typeof createCallSession>[0]) {
  ensureConversation(opts.conversationId);
  return createCallSession(opts);
}

/** Backdate a session's createdAt so it appears older than the grace period. */
function backdateSession(sessionId: string, ageMs: number): void {
  const db = getDb();
  const past = Date.now() - ageMs;
  db.run(
    `UPDATE call_sessions SET created_at = ${past} WHERE id = '${sessionId}'`,
  );
}

/** Create a mock VoiceProvider that returns configurable statuses. */
function createMockProvider(
  statusMap: Record<string, string> = {},
): VoiceProvider {
  return {
    name: "mock-twilio",
    initiateCall: async () => ({ callSid: "mock-sid" }),
    endCall: async () => {},
    getCallStatus: async (callSid: string) => {
      const status = statusMap[callSid];
      if (status === undefined) {
        throw new Error(`Unknown call SID: ${callSid}`);
      }
      return status;
    },
  };
}

/** Silent logger for tests */
const silentLog = new Proxy({} as Record<string, unknown>, {
  get: () => () => {},
}) as unknown as ReturnType<typeof import("../util/logger.js").getLogger>;

describe("listRecoverableCalls", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns sessions in non-terminal states", () => {
    const s1 = createTestCallSession({
      conversationId: "conv-r1",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    // s1 is 'initiated' — should be recoverable

    const s2 = createTestCallSession({
      conversationId: "conv-r2",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15553333333",
    });
    updateCallSession(s2.id, { status: "in_progress" });
    // s2 is 'in_progress' — should be recoverable

    const s3 = createTestCallSession({
      conversationId: "conv-r3",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15554444444",
    });
    updateCallSession(s3.id, { status: "ringing" });
    // s3 is 'ringing' — should be recoverable

    const results = listRecoverableCalls();
    const ids = results.map((r) => r.id);

    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
    expect(ids).toContain(s3.id);
    expect(results).toHaveLength(3);
  });

  test("does not include terminal calls (completed, failed, cancelled)", () => {
    const completed = createTestCallSession({
      conversationId: "conv-t1",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(completed.id, { status: "completed" });

    const failed = createTestCallSession({
      conversationId: "conv-t2",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15553333333",
    });
    updateCallSession(failed.id, { status: "failed" });

    const cancelled = createTestCallSession({
      conversationId: "conv-t3",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15554444444",
    });
    updateCallSession(cancelled.id, { status: "cancelled" });

    const results = listRecoverableCalls();
    expect(results).toHaveLength(0);
  });

  test("returns empty array when no calls exist", () => {
    const results = listRecoverableCalls();
    expect(results).toHaveLength(0);
  });

  test("includes waiting_on_user status", () => {
    const session = createTestCallSession({
      conversationId: "conv-w1",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, { status: "in_progress" });
    updateCallSession(session.id, { status: "waiting_on_user" });

    const results = listRecoverableCalls();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(session.id);
    expect(results[0].status).toBe("waiting_on_user");
  });
});

describe("reconcileCallsOnStartup", () => {
  beforeEach(() => {
    resetTables();
    clearActiveCallLeases();
  });

  test("does nothing when no recoverable calls exist", async () => {
    const provider = createMockProvider();
    await reconcileCallsOnStartup(provider, silentLog);
    // Should complete without error
  });

  test("fails stale no-SID sessions past grace period", async () => {
    const session = createTestCallSession({
      conversationId: "conv-nosid",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    upsertActiveCallLease({ callSessionId: session.id });
    // Backdate session so it exceeds the grace period
    backdateSession(session.id, NO_SID_GRACE_PERIOD_MS + 10_000);

    const provider = createMockProvider();
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    // Should be failed — orphan session past grace period
    expect(updated!.status).toBe("failed");
    expect(updated!.endedAt).not.toBeNull();
    expect(updated!.lastError).toContain("grace period expired");
    expect(listActiveCallLeases()).toHaveLength(0);
  });

  test("clears orphaned leases when startup finds no recoverable calls", async () => {
    upsertActiveCallLease({
      callSessionId: "call-orphaned-lease",
      providerCallSid: "CA_orphaned_lease",
    });

    expect(listActiveCallLeases()).toHaveLength(1);

    const provider = createMockProvider();
    await reconcileCallsOnStartup(provider, silentLog);

    expect(listActiveCallLeases()).toHaveLength(0);
  });

  test("rebuilds leases for calls that are still active on the provider", async () => {
    const session = createTestCallSession({
      conversationId: "conv-active-recovery",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, { providerCallSid: "CA_active_1" });
    clearActiveCallLeases();

    const provider = createMockProvider({
      CA_active_1: "in-progress",
    });
    await reconcileCallsOnStartup(provider, silentLog);

    expect(listActiveCallLeases()).toEqual([
      {
        callSessionId: session.id,
        providerCallSid: "CA_active_1",
        updatedAt: expect.any(Number),
      },
    ]);
  });

  test("expires pending questions when stale no-SID session is failed", async () => {
    const session = createTestCallSession({
      conversationId: "conv-nosid-pq",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    // Backdate session so it exceeds the grace period
    backdateSession(session.id, NO_SID_GRACE_PERIOD_MS + 10_000);

    // Create a pending question
    createPendingQuestion(session.id, "Are you still there?");
    const pendingBefore = getPendingQuestion(session.id);
    expect(pendingBefore).not.toBeNull();
    expect(pendingBefore!.status).toBe("pending");

    const provider = createMockProvider();
    await reconcileCallsOnStartup(provider, silentLog);

    // Pending question should be expired along with the session
    const pendingAfter = getPendingQuestion(session.id);
    expect(pendingAfter).toBeNull();
  });

  test("skips recent no-SID sessions within grace period", async () => {
    const session = createTestCallSession({
      conversationId: "conv-nosid-recent",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    // Session was just created (createdAt ~ Date.now()), well within grace period

    const provider = createMockProvider();
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    // Should NOT be failed — still in its original non-terminal state
    expect(updated!.status).toBe("initiated");
    expect(updated!.endedAt).toBeNull();
    expect(updated!.lastError).toContain("awaiting webhook");
  });

  test("transitions to completed when provider says call completed", async () => {
    const session = createTestCallSession({
      conversationId: "conv-comp",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_completed_123",
      status: "in_progress",
    });

    const provider = createMockProvider({ CA_completed_123: "completed" });
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");
    expect(updated!.endedAt).not.toBeNull();
  });

  test("transitions to failed when provider says call failed", async () => {
    const session = createTestCallSession({
      conversationId: "conv-fail",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_failed_123",
      status: "ringing",
    });

    const provider = createMockProvider({ CA_failed_123: "failed" });
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.endedAt).not.toBeNull();
  });

  test("leaves call active when provider says call is still in-progress", async () => {
    const session = createTestCallSession({
      conversationId: "conv-active",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_active_123",
      status: "in_progress",
    });

    const provider = createMockProvider({ CA_active_123: "in-progress" });
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");
    expect(updated!.endedAt).toBeNull();
  });

  test("leaves call active when provider says call is ringing", async () => {
    const session = createTestCallSession({
      conversationId: "conv-ring",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_ringing_123",
      status: "ringing",
    });

    const provider = createMockProvider({ CA_ringing_123: "ringing" });
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("ringing");
    expect(updated!.endedAt).toBeNull();
  });

  test("expires pending questions when call transitions to terminal state", async () => {
    const session = createTestCallSession({
      conversationId: "conv-expire",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_expire_123",
      status: "in_progress",
    });
    updateCallSession(session.id, { status: "waiting_on_user" });

    // Create a pending question
    createPendingQuestion(session.id, "What is your name?");

    // Verify the question is pending
    const pendingBefore = getPendingQuestion(session.id);
    expect(pendingBefore).not.toBeNull();
    expect(pendingBefore!.status).toBe("pending");

    const provider = createMockProvider({ CA_expire_123: "completed" });
    await reconcileCallsOnStartup(provider, silentLog);

    // Pending question should be expired
    const pendingAfter = getPendingQuestion(session.id);
    expect(pendingAfter).toBeNull();
  });

  test("does not expire pending questions when call stays active", async () => {
    const session = createTestCallSession({
      conversationId: "conv-keep",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_keep_123",
      status: "in_progress",
    });
    updateCallSession(session.id, { status: "waiting_on_user" });

    createPendingQuestion(session.id, "Still waiting?");

    const provider = createMockProvider({ CA_keep_123: "in-progress" });
    await reconcileCallsOnStartup(provider, silentLog);

    // The pending question should still be there
    const pendingAfter = getPendingQuestion(session.id);
    expect(pendingAfter).not.toBeNull();
    expect(pendingAfter!.status).toBe("pending");
  });

  test("fails call when provider status fetch throws", async () => {
    const session = createTestCallSession({
      conversationId: "conv-err",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_error_123",
      status: "in_progress",
    });

    // Provider will throw for unknown SIDs
    const provider = createMockProvider({});
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.lastError).toContain(
      "Recovery: failed to fetch provider status",
    );
  });

  test("fails call when provider returns unrecognised status", async () => {
    const session = createTestCallSession({
      conversationId: "conv-unk",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    updateCallSession(session.id, {
      providerCallSid: "CA_unknown_123",
      status: "in_progress",
    });

    const provider = createMockProvider({
      CA_unknown_123: "some-unknown-status",
    });
    await reconcileCallsOnStartup(provider, silentLog);

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.lastError).toContain(
      "unrecognised provider status 'some-unknown-status'",
    );
  });

  test("handles mixed recoverable calls correctly", async () => {
    // Call 1: no SID, stale — should be failed (orphan past grace period)
    const noSid = createTestCallSession({
      conversationId: "conv-mix1",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    backdateSession(noSid.id, NO_SID_GRACE_PERIOD_MS + 10_000);

    // Call 2: provider says completed — should complete
    const completed = createTestCallSession({
      conversationId: "conv-mix2",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15553333333",
    });
    updateCallSession(completed.id, {
      providerCallSid: "CA_mix_completed",
      status: "in_progress",
    });

    // Call 3: provider says still active — should stay
    const active = createTestCallSession({
      conversationId: "conv-mix3",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15554444444",
    });
    updateCallSession(active.id, {
      providerCallSid: "CA_mix_active",
      status: "ringing",
    });

    const provider = createMockProvider({
      CA_mix_completed: "completed",
      CA_mix_active: "ringing",
    });

    await reconcileCallsOnStartup(provider, silentLog);

    // No-SID session failed — orphan past grace period
    const updatedNoSid = getCallSession(noSid.id);
    expect(updatedNoSid!.status).toBe("failed");
    expect(updatedNoSid!.endedAt).not.toBeNull();
    expect(updatedNoSid!.lastError).toContain("grace period expired");

    const updatedCompleted = getCallSession(completed.id);
    expect(updatedCompleted!.status).toBe("completed");

    const updatedActive = getCallSession(active.id);
    expect(updatedActive!.status).toBe("ringing");
  });
});

describe("logDeadLetterEvent", () => {
  test("does not throw when called with a payload", () => {
    expect(() => {
      logDeadLetterEvent("test reason", { foo: "bar" }, silentLog);
    }).not.toThrow();
  });

  test("does not throw when called with null payload", () => {
    expect(() => {
      logDeadLetterEvent("null payload", null, silentLog);
    }).not.toThrow();
  });
});
