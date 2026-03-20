import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "canonical-guardian-store-test-"));

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
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  expireAllPendingCanonicalRequests,
  getCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
  listPendingCanonicalGuardianRequestsByDestinationChat,
  listPendingCanonicalGuardianRequestsByDestinationConversation,
  listPendingRequestsByConversationScope,
  resolveCanonicalGuardianRequest,
  updateCanonicalGuardianDelivery,
  updateCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

// All decisionable kinds (tool_approval, pending_question, access_request)
// require a guardianPrincipalId. Use a constant for test fixtures.
const TEST_PRINCIPAL = "test-principal-id";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

describe("canonical-guardian-store", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── createCanonicalGuardianRequest ────────────────────────────────

  test("creates a request with all fields populated", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "twilio",
      conversationId: "conv-1",
      requesterExternalUserId: "user-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: TEST_PRINCIPAL,
      callSessionId: "session-1",
      pendingQuestionId: "pq-1",
      questionText: "Can I run this tool?",
      requestCode: "ABC123",
      toolName: "file_edit",
      inputDigest: "sha256:deadbeef",
      expiresAt: Date.now() + 60_000,
    });

    expect(req.id).toBeTruthy();
    expect(req.kind).toBe("tool_approval");
    expect(req.sourceType).toBe("voice");
    expect(req.sourceChannel).toBe("twilio");
    expect(req.status).toBe("pending");
    expect(req.toolName).toBe("file_edit");
    expect(req.createdAt).toBeTruthy();
    expect(req.updatedAt).toBeTruthy();
  });

  test("creates a request with minimal fields", () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    expect(req.id).toBeTruthy();
    expect(req.kind).toBe("access_request");
    expect(req.sourceType).toBe("channel");
    expect(req.sourceChannel).toBeNull();
    expect(req.conversationId).toBeNull();
    expect(req.toolName).toBeNull();
    expect(req.status).toBe("pending");
  });

  // ── getCanonicalGuardianRequest ───────────────────────────────────

  test("gets a request by ID", () => {
    const created = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const fetched = getCanonicalGuardianRequest(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.kind).toBe("tool_approval");
  });

  test("returns null for nonexistent ID", () => {
    const fetched = getCanonicalGuardianRequest("nonexistent");
    expect(fetched).toBeNull();
  });

  // ── listCanonicalGuardianRequests ─────────────────────────────────

  test("lists all requests with no filters", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const all = listCanonicalGuardianRequests();
    expect(all).toHaveLength(2);
  });

  test("filters by status", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    const req2 = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    updateCanonicalGuardianRequest(req2.id, { status: "approved" });

    const pending = listCanonicalGuardianRequests({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("tool_approval");

    const approved = listCanonicalGuardianRequests({ status: "approved" });
    expect(approved).toHaveLength(1);
    expect(approved[0].kind).toBe("access_request");
  });

  test("filters by guardianExternalUserId", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianExternalUserId: "guardian-A",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianExternalUserId: "guardian-B",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const filtered = listCanonicalGuardianRequests({
      guardianExternalUserId: "guardian-A",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].guardianExternalUserId).toBe("guardian-A");
  });

  test("filters by conversationId", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      conversationId: "conv-X",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      conversationId: "conv-Y",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const filtered = listCanonicalGuardianRequests({
      conversationId: "conv-X",
    });
    expect(filtered).toHaveLength(1);
  });

  test("filters by sourceType", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const voiceOnly = listCanonicalGuardianRequests({ sourceType: "voice" });
    expect(voiceOnly).toHaveLength(1);
  });

  test("filters by kind", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const toolOnly = listCanonicalGuardianRequests({ kind: "tool_approval" });
    expect(toolOnly).toHaveLength(1);
  });

  test("combines multiple filters", () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianExternalUserId: "guardian-A",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      guardianExternalUserId: "guardian-A",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "voice",
      guardianExternalUserId: "guardian-A",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const filtered = listCanonicalGuardianRequests({
      kind: "tool_approval",
      sourceType: "voice",
      guardianExternalUserId: "guardian-A",
    });
    expect(filtered).toHaveLength(1);
  });

  // ── updateCanonicalGuardianRequest ────────────────────────────────

  test("updates request fields", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const updated = updateCanonicalGuardianRequest(req.id, {
      status: "approved",
      answerText: "Looks good",
      decidedByExternalUserId: "guardian-1",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("approved");
    expect(updated!.answerText).toBe("Looks good");
    expect(updated!.decidedByExternalUserId).toBe("guardian-1");
    // updatedAt should be at least as recent as the original (may be the
    // same millisecond when create+update run back-to-back in tests).
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(req.updatedAt);
  });

  test("returns null when updating nonexistent request", () => {
    const updated = updateCanonicalGuardianRequest("nonexistent", {
      status: "approved",
    });
    expect(updated).toBeNull();
  });

  // ── resolveCanonicalGuardianRequest (CAS) ─────────────────────────

  test("resolves a pending request to approved", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const resolved = resolveCanonicalGuardianRequest(req.id, "pending", {
      status: "approved",
      answerText: "Approved by guardian",
      decidedByExternalUserId: "guardian-1",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("approved");
    expect(resolved!.answerText).toBe("Approved by guardian");
    expect(resolved!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("resolves a pending request to denied", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const resolved = resolveCanonicalGuardianRequest(req.id, "pending", {
      status: "denied",
      answerText: "Not allowed",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("denied");
  });

  test("CAS fails when expectedStatus does not match", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    // Try to resolve with wrong expected status
    const result = resolveCanonicalGuardianRequest(req.id, "approved", {
      status: "denied",
    });

    expect(result).toBeNull();

    // Verify the request is unchanged
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });

  test("CAS race condition: two concurrent resolves, only one succeeds", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    // First resolve succeeds
    const first = resolveCanonicalGuardianRequest(req.id, "pending", {
      status: "approved",
      answerText: "First approver",
      decidedByExternalUserId: "guardian-1",
    });
    expect(first).not.toBeNull();
    expect(first!.status).toBe("approved");

    // Second resolve fails because status is no longer 'pending'
    const second = resolveCanonicalGuardianRequest(req.id, "pending", {
      status: "denied",
      answerText: "Second denier",
      decidedByExternalUserId: "guardian-2",
    });
    expect(second).toBeNull();

    // Verify the first decision stuck
    const final = getCanonicalGuardianRequest(req.id);
    expect(final!.status).toBe("approved");
    expect(final!.answerText).toBe("First approver");
    expect(final!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("CAS returns null for nonexistent request", () => {
    const result = resolveCanonicalGuardianRequest("nonexistent", "pending", {
      status: "approved",
    });
    expect(result).toBeNull();
  });

  // ── Voice-originated and channel-originated request shapes ────────

  test("voice-originated request shape is representable", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "twilio",
      conversationId: "conv-voice-1",
      guardianExternalUserId: "guardian-phone",
      guardianPrincipalId: TEST_PRINCIPAL,
      callSessionId: "call-123",
      pendingQuestionId: "pq-456",
      questionText: "What is the gate code?",
      requestCode: "A1B2C3",
      expiresAt: Date.now() + 30_000,
    });

    expect(req.sourceType).toBe("voice");
    expect(req.callSessionId).toBe("call-123");
    expect(req.pendingQuestionId).toBe("pq-456");
    expect(req.requestCode).toBe("A1B2C3");
  });

  test("channel-originated request shape is representable", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-tg-1",
      requesterExternalUserId: "requester-tg-user",
      guardianExternalUserId: "guardian-tg-user",
      guardianPrincipalId: TEST_PRINCIPAL,
      toolName: "execute_code",
      inputDigest: "sha256:abcdef",
      expiresAt: Date.now() + 120_000,
    });

    expect(req.sourceType).toBe("channel");
    expect(req.sourceChannel).toBe("telegram");
    expect(req.requesterExternalUserId).toBe("requester-tg-user");
    expect(req.toolName).toBe("execute_code");
    // Voice-specific fields are null for channel requests
    expect(req.callSessionId).toBeNull();
    expect(req.pendingQuestionId).toBeNull();
  });

  test("desktop-originated request shape is representable", () => {
    const req = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "desktop",
      conversationId: "conv-desktop-1",
      guardianExternalUserId: "guardian-desktop",
      guardianPrincipalId: TEST_PRINCIPAL,
      questionText: "User wants to access settings",
    });

    expect(req.sourceType).toBe("desktop");
    expect(req.sourceChannel).toBeNull();
    expect(req.callSessionId).toBeNull();
  });

  // ── Canonical Guardian Deliveries ─────────────────────────────────

  test("creates and lists deliveries for a request", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const d1 = createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-123",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "phone",
      destinationChatId: "chat-456",
    });

    expect(d1.id).toBeTruthy();
    expect(d1.requestId).toBe(req.id);
    expect(d1.destinationChannel).toBe("telegram");
    expect(d1.status).toBe("pending");

    const deliveries = listCanonicalGuardianDeliveries(req.id);
    expect(deliveries).toHaveLength(2);
    const channels = deliveries.map((d) => d.destinationChannel).sort();
    expect(channels).toEqual(["phone", "telegram"]);
  });

  test("lists empty deliveries for a request with none", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const deliveries = listCanonicalGuardianDeliveries(req.id);
    expect(deliveries).toHaveLength(0);
  });

  test("lists pending requests by destination conversation", () => {
    const pendingReq = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    const resolvedReq = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    updateCanonicalGuardianRequest(resolvedReq.id, { status: "approved" });

    createCanonicalGuardianDelivery({
      requestId: pendingReq.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-1",
    });
    createCanonicalGuardianDelivery({
      requestId: resolvedReq.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-1",
    });

    const pending =
      listPendingCanonicalGuardianRequestsByDestinationConversation(
        "conv-guardian-1",
        "vellum",
      );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(pendingReq.id);
  });

  test("destination conversation lookup deduplicates request IDs", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-guardian-2",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-guardian-2",
    });

    const pending =
      listPendingCanonicalGuardianRequestsByDestinationConversation(
        "conv-guardian-2",
      );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(req.id);
  });

  test("updates delivery status", () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    const delivery = createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
    });

    const updated = updateCanonicalGuardianDelivery(delivery.id, {
      status: "sent",
      destinationMessageId: "msg-789",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("sent");
    expect(updated!.destinationMessageId).toBe("msg-789");
  });

  test("returns null when updating nonexistent delivery", () => {
    const updated = updateCanonicalGuardianDelivery("nonexistent", {
      status: "sent",
    });
    expect(updated).toBeNull();
  });

  // ── listPendingCanonicalGuardianRequestsByDestinationChat ──────────

  test("returns pending requests matching (destinationChannel, destinationChatId)", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-100",
    });

    const pending = listPendingCanonicalGuardianRequestsByDestinationChat(
      "telegram",
      "guardian-chat-100",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(req.id);
  });

  test("excludes non-pending requests from destination chat lookup", () => {
    const pendingReq = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    const resolvedReq = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    updateCanonicalGuardianRequest(resolvedReq.id, { status: "approved" });

    createCanonicalGuardianDelivery({
      requestId: pendingReq.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-200",
    });
    createCanonicalGuardianDelivery({
      requestId: resolvedReq.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-200",
    });

    const pending = listPendingCanonicalGuardianRequestsByDestinationChat(
      "telegram",
      "guardian-chat-200",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(pendingReq.id);
  });

  test("deduplicates when multiple delivery rows point to same request", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    // Two delivery rows targeting the same chat for the same request
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-300",
      destinationMessageId: "msg-1",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-300",
      destinationMessageId: "msg-2",
    });

    const pending = listPendingCanonicalGuardianRequestsByDestinationChat(
      "telegram",
      "guardian-chat-300",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(req.id);
  });

  test("channel mismatch does not match in destination chat lookup", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-400",
    });

    const pending = listPendingCanonicalGuardianRequestsByDestinationChat(
      "phone",
      "guardian-chat-400",
    );
    expect(pending).toHaveLength(0);
  });

  test("chat mismatch does not match in destination chat lookup", () => {
    const req = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "guardian-chat-500",
    });

    const pending = listPendingCanonicalGuardianRequestsByDestinationChat(
      "telegram",
      "different-chat-id",
    );
    expect(pending).toHaveLength(0);
  });

  // ── listPendingRequestsByConversationScope expiry filtering ─────────

  test("listPendingRequestsByConversationScope excludes expired requests", () => {
    // Create a pending request that has already expired
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-scope-1",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() - 10_000,
    });

    // Create a pending request that has not expired
    const unexpired = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-scope-1",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() + 60_000,
    });

    const results = listPendingRequestsByConversationScope("conv-scope-1");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(unexpired.id);
  });

  test("listPendingRequestsByConversationScope includes requests with no expiresAt", () => {
    const noExpiry = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-scope-2",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const results = listPendingRequestsByConversationScope("conv-scope-2");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(noExpiry.id);
  });

  // ── expireAllPendingCanonicalRequests ───────────────────────────────

  test("expireAllPendingCanonicalRequests transitions interaction-bound pending to expired", () => {
    const req1 = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-bulk-1",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() + 60_000,
    });
    const req2 = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "channel",
      conversationId: "conv-bulk-2",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() + 60_000,
    });

    const count = expireAllPendingCanonicalRequests();
    expect(count).toBe(2);

    expect(getCanonicalGuardianRequest(req1.id)!.status).toBe("expired");
    expect(getCanonicalGuardianRequest(req2.id)!.status).toBe("expired");
  });

  test("expireAllPendingCanonicalRequests does not expire persistent kinds (access_request, tool_grant_request)", () => {
    const accessReq = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      conversationId: "conv-bulk-persist-1",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    const grantReq = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      conversationId: "conv-bulk-persist-2",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    // Also create an interaction-bound request to verify selective expiry
    const toolApproval = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-bulk-persist-3",
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    const count = expireAllPendingCanonicalRequests();
    expect(count).toBe(1); // Only tool_approval expired

    expect(getCanonicalGuardianRequest(accessReq.id)!.status).toBe("pending");
    expect(getCanonicalGuardianRequest(grantReq.id)!.status).toBe("pending");
    expect(getCanonicalGuardianRequest(toolApproval.id)!.status).toBe(
      "expired",
    );
  });

  test("expireAllPendingCanonicalRequests expires persistent kinds with past expiresAt", () => {
    const expiredAccess = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      conversationId: "conv-bulk-persist-expired-1",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() - 10_000,
    });
    const expiredGrant = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      conversationId: "conv-bulk-persist-expired-2",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() - 10_000,
    });
    // Persistent kind with future expiresAt should NOT be expired
    const futureAccess = createCanonicalGuardianRequest({
      kind: "access_request",
      sourceType: "channel",
      conversationId: "conv-bulk-persist-expired-3",
      guardianPrincipalId: TEST_PRINCIPAL,
      expiresAt: Date.now() + 60_000,
    });

    const count = expireAllPendingCanonicalRequests();
    expect(count).toBe(2);

    expect(getCanonicalGuardianRequest(expiredAccess.id)!.status).toBe(
      "expired",
    );
    expect(getCanonicalGuardianRequest(expiredGrant.id)!.status).toBe(
      "expired",
    );
    expect(getCanonicalGuardianRequest(futureAccess.id)!.status).toBe(
      "pending",
    );
  });

  test("expireAllPendingCanonicalRequests does not affect already-resolved requests", () => {
    const approved = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-bulk-3",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    updateCanonicalGuardianRequest(approved.id, { status: "approved" });

    const denied = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-bulk-3",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    updateCanonicalGuardianRequest(denied.id, { status: "denied" });

    const count = expireAllPendingCanonicalRequests();
    expect(count).toBe(0);

    expect(getCanonicalGuardianRequest(approved.id)!.status).toBe("approved");
    expect(getCanonicalGuardianRequest(denied.id)!.status).toBe("denied");
  });

  test("expireAllPendingCanonicalRequests returns 0 when no pending requests exist", () => {
    const count = expireAllPendingCanonicalRequests();
    expect(count).toBe(0);
  });
});
