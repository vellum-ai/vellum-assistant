import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";

import "../../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../connection.js";
import { guardianRequestDeliveries, guardianRequests } from "../schema.js";
import {
  createDelivery,
  createGuardianRequest,
  expireAllPendingInteractionBound,
  expireGuardianRequest,
  generateRequestCode,
  getByPendingQuestionId,
  getGuardianRequest,
  getGuardianRequestByCode,
  getPendingByCallSessionId,
  getPendingByDestinationMessage,
  GuardianRequestIntegrityError,
  isRequestInConversationScope,
  listDeliveries,
  listGuardianRequests,
  listPendingByConversationScope,
  listPendingByDestinationChat,
  listPendingByDestinationConversation,
  resolveGuardianRequest,
  sweepExpiredGuardianRequests,
  updateDelivery,
  updateGuardianRequest,
} from "../guardian-request-store.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const FUTURE = () => Date.now() + 10 * 60 * 1000;
const PAST = () => Date.now() - 10_000;

// All decisionable kinds require a guardianPrincipalId at creation.
const TEST_PRINCIPAL = "test-principal-id";

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(guardianRequestDeliveries).run();
  getGatewayDb().delete(guardianRequests).run();
});

afterEach(() => {
  resetGatewayDb();
});

function createRequest(
  overrides: Partial<Parameters<typeof createGuardianRequest>[0]> = {},
) {
  return createGuardianRequest({
    kind: "access_request",
    guardianPrincipalId: TEST_PRINCIPAL,
    ...overrides,
  });
}

/** A uuid whose first 6 hex chars (dashes stripped) form the given code. */
function uuidForCode(code: string): ReturnType<typeof crypto.randomUUID> {
  return `${code.toLowerCase()}00-0000-4000-8000-000000000000` as ReturnType<
    typeof crypto.randomUUID
  >;
}

// ---------------------------------------------------------------------------
// createGuardianRequest
// ---------------------------------------------------------------------------

describe("createGuardianRequest", () => {
  test("round-trips a fully populated request", () => {
    const expiresAt = FUTURE();
    const req = createRequest({
      kind: "pending_question",
      sourceChannel: "phone",
      sourceConversationId: "conv-1",
      requesterExternalUserId: "user-1",
      requesterChatId: "+15555550100",
      guardianExternalUserId: "guardian-1",
      callSessionId: "call-1",
      pendingQuestionId: "pq-1",
      questionText: "What is the gate code?",
      requestCode: "A1B2C3",
      toolName: "file_edit",
      inputDigest: "sha256:deadbeef",
      commandPreview: "rm -rf /tmp/test",
      riskLevel: "high",
      activityText: "Deleting temporary test files",
      executionTarget: "host",
      requesterSignals: '{"isBot":false}',
      requestTrigger: "admitted",
      followupState: "none",
      expiresAt,
    });

    expect(req.id).toBeTruthy();
    expect(req.status).toBe("pending");
    expect(req.createdAt).toBeTruthy();

    const fetched = getGuardianRequest(req.id);
    expect(fetched).toEqual(req);
    expect(fetched?.sourceConversationId).toBe("conv-1");
    expect(fetched?.requestTrigger).toBe("admitted");
    expect(fetched?.commandPreview).toBe("rm -rf /tmp/test");
    expect(fetched?.expiresAt).toBe(expiresAt);
  });

  test("defaults optional fields to null and generates id + code", () => {
    const req = createRequest();

    expect(req.id).toBeTruthy();
    expect(req.requestCode).toMatch(/^[0-9A-F]{6}$/);
    expect(req.sourceChannel).toBeNull();
    expect(req.sourceConversationId).toBeNull();
    expect(req.toolName).toBeNull();
    expect(req.requestTrigger).toBeNull();
    expect(req.status).toBe("pending");
  });

  test("honors caller-supplied ids", () => {
    const id = "access-req-self-telegram-user-1-1234567890";
    const req = createRequest({ id });
    expect(req.id).toBe(id);
    expect(getGuardianRequest(id)?.id).toBe(id);
  });

  test("rejects decisionable kinds without guardianPrincipalId", () => {
    for (const kind of [
      "access_request",
      "tool_approval",
      "tool_grant_request",
      "pending_question",
    ]) {
      let thrown: unknown;
      try {
        createGuardianRequest({ kind });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GuardianRequestIntegrityError);
      expect((thrown as GuardianRequestIntegrityError).code).toBe(
        "guardian_principal_required",
      );
      // Surfaces as a 4xx client error over IPC.
      expect((thrown as GuardianRequestIntegrityError).statusCode).toBe(400);
    }
    expect(listGuardianRequests()).toHaveLength(0);
  });

  test("allows non-decisionable kinds without guardianPrincipalId", () => {
    const req = createGuardianRequest({ kind: "status_update" });
    expect(req.guardianPrincipalId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateRequestCode
// ---------------------------------------------------------------------------

describe("generateRequestCode", () => {
  test("retries when the code collides with a pending request", () => {
    createRequest({ requestCode: "ABC123" });

    const spy = spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(uuidForCode("abc123"))
      .mockReturnValueOnce(uuidForCode("def456"));

    expect(generateRequestCode()).toBe("DEF456");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("returns the colliding code after exhausting retries", () => {
    createRequest({ requestCode: "ABC123" });

    const spy = spyOn(crypto, "randomUUID").mockReturnValue(
      uuidForCode("abc123"),
    );

    expect(generateRequestCode()).toBe("ABC123");
    expect(spy).toHaveBeenCalledTimes(6);
    spy.mockRestore();
  });

  test("resolved requests do not count as collisions", () => {
    const req = createRequest({ requestCode: "ABC123" });
    updateGuardianRequest(req.id, { status: "approved" });

    const spy = spyOn(crypto, "randomUUID").mockReturnValueOnce(
      uuidForCode("abc123"),
    );

    expect(generateRequestCode()).toBe("ABC123");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getGuardianRequest / getGuardianRequestByCode
// ---------------------------------------------------------------------------

describe("getGuardianRequest", () => {
  test("returns null for a nonexistent id", () => {
    expect(getGuardianRequest("missing")).toBeNull();
  });
});

describe("getGuardianRequestByCode", () => {
  test("matches pending requests only", () => {
    const pending = createRequest({ requestCode: "AAA111" });
    const resolved = createRequest({ requestCode: "BBB222" });
    updateGuardianRequest(resolved.id, { status: "approved" });

    expect(getGuardianRequestByCode("AAA111")?.id).toBe(pending.id);
    expect(getGuardianRequestByCode("BBB222")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listGuardianRequests
// ---------------------------------------------------------------------------

describe("listGuardianRequests", () => {
  test("lists all requests with no filters", () => {
    createRequest();
    createRequest({ kind: "tool_approval" });
    expect(listGuardianRequests()).toHaveLength(2);
  });

  test("filters by status, kind, guardian, requester, and conversation", () => {
    const match = createRequest({
      kind: "tool_approval",
      guardianExternalUserId: "guardian-A",
      requesterExternalUserId: "requester-A",
      sourceConversationId: "conv-A",
      toolName: "execute_code",
    });
    createRequest({
      kind: "tool_approval",
      guardianExternalUserId: "guardian-B",
      requesterExternalUserId: "requester-B",
      sourceConversationId: "conv-B",
      toolName: "file_edit",
    });
    const approved = createRequest({ kind: "tool_approval" });
    updateGuardianRequest(approved.id, { status: "approved" });

    expect(listGuardianRequests({ status: "pending" })).toHaveLength(2);
    expect(listGuardianRequests({ status: "approved" })).toHaveLength(1);
    expect(
      listGuardianRequests({
        status: "pending",
        kind: "tool_approval",
        guardianExternalUserId: "guardian-A",
        guardianPrincipalId: TEST_PRINCIPAL,
        requesterExternalUserId: "requester-A",
        sourceConversationId: "conv-A",
        toolName: "execute_code",
      }).map((r) => r.id),
    ).toEqual([match.id]);
  });

  test("filters by sourceChannel", () => {
    createRequest({ sourceChannel: "telegram" });
    createRequest({ sourceChannel: "slack" });

    const filtered = listGuardianRequests({ sourceChannel: "telegram" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sourceChannel).toBe("telegram");
  });

  test("translates the sourceType filter to source_channel predicates", () => {
    const voice = createRequest({ sourceChannel: "phone" });
    const desktop = createRequest({ sourceChannel: "vellum" });
    const telegram = createRequest({ sourceChannel: "telegram" });
    const channelless = createRequest();

    expect(
      listGuardianRequests({ sourceType: "voice" }).map((r) => r.id),
    ).toEqual([voice.id]);
    expect(
      listGuardianRequests({ sourceType: "desktop" }).map((r) => r.id),
    ).toEqual([desktop.id]);
    expect(
      listGuardianRequests({ sourceType: "channel" })
        .map((r) => r.id)
        .sort(),
    ).toEqual([telegram.id, channelless.id].sort());
  });
});

// ---------------------------------------------------------------------------
// updateGuardianRequest
// ---------------------------------------------------------------------------

describe("updateGuardianRequest", () => {
  test("applies partial updates", () => {
    const req = createRequest();

    const updated = updateGuardianRequest(req.id, {
      status: "approved",
      answerText: "Looks good",
      decidedByExternalUserId: "guardian-1",
      decidedByPrincipalId: TEST_PRINCIPAL,
      followupState: "inline_wait_active:123",
      expiresAt: 42,
    });

    expect(updated?.status).toBe("approved");
    expect(updated?.answerText).toBe("Looks good");
    expect(updated?.decidedByExternalUserId).toBe("guardian-1");
    expect(updated?.decidedByPrincipalId).toBe(TEST_PRINCIPAL);
    expect(updated?.followupState).toBe("inline_wait_active:123");
    expect(updated?.expiresAt).toBe(42);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(req.updatedAt);
  });

  test("clears followupState with an explicit null", () => {
    const req = createRequest({ followupState: "none" });
    const updated = updateGuardianRequest(req.id, { followupState: null });
    expect(updated?.followupState).toBeNull();
  });

  test("returns null for a nonexistent request", () => {
    expect(updateGuardianRequest("missing", { status: "approved" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveGuardianRequest (CAS)
// ---------------------------------------------------------------------------

describe("resolveGuardianRequest", () => {
  test("resolves a pending request and stamps decision fields", () => {
    const req = createRequest();

    const result = resolveGuardianRequest(req.id, "pending", {
      status: "approved",
      answerText: "Approved by guardian",
      decidedByExternalUserId: "guardian-1",
      decidedByPrincipalId: TEST_PRINCIPAL,
    });

    if (!result.applied) {
      throw new Error("expected resolve to apply");
    }
    expect(result.request.status).toBe("approved");
    expect(result.request.answerText).toBe("Approved by guardian");
    expect(result.request.decidedByExternalUserId).toBe("guardian-1");
    expect(result.request.decidedByPrincipalId).toBe(TEST_PRINCIPAL);
  });

  test("first writer wins — the second resolve returns applied:false", () => {
    const req = createRequest();

    const first = resolveGuardianRequest(req.id, "pending", {
      status: "approved",
      answerText: "First approver",
      decidedByExternalUserId: "guardian-1",
    });
    const second = resolveGuardianRequest(req.id, "pending", {
      status: "denied",
      answerText: "Second denier",
      decidedByExternalUserId: "guardian-2",
    });

    expect(first.applied).toBe(true);
    expect(second).toEqual({ applied: false });

    const final = getGuardianRequest(req.id);
    expect(final?.status).toBe("approved");
    expect(final?.answerText).toBe("First approver");
    expect(final?.decidedByExternalUserId).toBe("guardian-1");
  });

  test("fails without side effects when expectedStatus does not match", () => {
    const req = createRequest();

    expect(
      resolveGuardianRequest(req.id, "approved", { status: "denied" }),
    ).toEqual({ applied: false });
    expect(getGuardianRequest(req.id)?.status).toBe("pending");
  });

  test("the CAS is direction-agnostic (terminal → pending swaps apply)", () => {
    const req = createRequest();
    resolveGuardianRequest(req.id, "pending", { status: "approved" });

    const swapped = resolveGuardianRequest(req.id, "approved", {
      status: "pending",
    });

    if (!swapped.applied) {
      throw new Error("expected swap to apply");
    }
    expect(swapped.request.status).toBe("pending");
    expect(getGuardianRequest(req.id)?.status).toBe("pending");
  });

  test("returns applied:false for a nonexistent request", () => {
    expect(
      resolveGuardianRequest("missing", "pending", { status: "approved" }),
    ).toEqual({ applied: false });
  });
});

// ---------------------------------------------------------------------------
// expireAllPendingInteractionBound
// ---------------------------------------------------------------------------

describe("expireAllPendingInteractionBound", () => {
  test("expires interaction-bound kinds unconditionally", () => {
    const toolApproval = createRequest({
      kind: "tool_approval",
      expiresAt: FUTURE(),
    });
    const pendingQuestion = createRequest({
      kind: "pending_question",
      expiresAt: FUTURE(),
    });

    expect(expireAllPendingInteractionBound()).toBe(2);
    expect(getGuardianRequest(toolApproval.id)?.status).toBe("expired");
    expect(getGuardianRequest(pendingQuestion.id)?.status).toBe("expired");
  });

  test("expires persistent kinds only past their deadline", () => {
    const staleAccess = createRequest({
      kind: "access_request",
      expiresAt: PAST(),
    });
    const staleGrant = createRequest({
      kind: "tool_grant_request",
      expiresAt: PAST(),
    });
    const freshAccess = createRequest({
      kind: "access_request",
      expiresAt: FUTURE(),
    });
    const deadlineless = createRequest({ kind: "tool_grant_request" });

    expect(expireAllPendingInteractionBound()).toBe(2);
    expect(getGuardianRequest(staleAccess.id)?.status).toBe("expired");
    expect(getGuardianRequest(staleGrant.id)?.status).toBe("expired");
    expect(getGuardianRequest(freshAccess.id)?.status).toBe("pending");
    expect(getGuardianRequest(deadlineless.id)?.status).toBe("pending");
  });

  test("leaves already-resolved requests untouched", () => {
    const approved = createRequest({ kind: "tool_approval" });
    updateGuardianRequest(approved.id, { status: "approved" });

    expect(expireAllPendingInteractionBound()).toBe(0);
    expect(getGuardianRequest(approved.id)?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// sweepExpiredGuardianRequests
// ---------------------------------------------------------------------------

describe("sweepExpiredGuardianRequests", () => {
  test("expires past-deadline pending rows and returns their rows", () => {
    const stale1 = createRequest({ expiresAt: PAST() });
    const stale2 = createRequest({
      kind: "tool_approval",
      expiresAt: PAST(),
    });
    const fresh = createRequest({ expiresAt: FUTURE() });
    const deadlineless = createRequest();
    const resolved = createRequest({ expiresAt: PAST() });
    updateGuardianRequest(resolved.id, { status: "denied" });

    const expired = sweepExpiredGuardianRequests();

    expect(expired.map((row) => row.id).sort()).toEqual(
      [stale1.id, stale2.id].sort(),
    );
    for (const row of expired) {
      expect(row.status).toBe("expired");
    }
    expect(getGuardianRequest(stale1.id)?.status).toBe("expired");
    expect(getGuardianRequest(stale2.id)?.status).toBe("expired");
    expect(getGuardianRequest(fresh.id)?.status).toBe("pending");
    expect(getGuardianRequest(deadlineless.id)?.status).toBe("pending");
    expect(getGuardianRequest(resolved.id)?.status).toBe("denied");
  });

  test("returns an empty list when nothing is stale", () => {
    createRequest({ expiresAt: FUTURE() });
    expect(sweepExpiredGuardianRequests()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expireGuardianRequest
// ---------------------------------------------------------------------------

describe("expireGuardianRequest", () => {
  test("expires a pending request and all its deliveries", () => {
    const req = createRequest();
    const d1 = createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
    });
    const d2 = createDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    expireGuardianRequest(req.id);

    expect(getGuardianRequest(req.id)?.status).toBe("expired");
    const statuses = listDeliveries(req.id).map((d) => d.status);
    expect(statuses).toEqual(["expired", "expired"]);
    expect([d1.status, d2.status]).toEqual(["pending", "pending"]);
  });

  test("does not overwrite an already-resolved request status", () => {
    const req = createRequest();
    resolveGuardianRequest(req.id, "pending", { status: "approved" });

    expireGuardianRequest(req.id);

    expect(getGuardianRequest(req.id)?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

describe("deliveries", () => {
  test("creates and lists deliveries for a request", () => {
    const req = createRequest();

    const d1 = createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-123",
    });
    createDelivery({
      requestId: req.id,
      destinationChannel: "phone",
      destinationChatId: "+15555550101",
    });

    expect(d1.id).toBeTruthy();
    expect(d1.requestId).toBe(req.id);
    expect(d1.status).toBe("pending");

    const deliveries = listDeliveries(req.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.destinationChannel).sort()).toEqual([
      "phone",
      "telegram",
    ]);
  });

  test("honors caller-supplied delivery ids", () => {
    const req = createRequest();
    const d = createDelivery({
      id: "delivery-1",
      requestId: req.id,
      destinationChannel: "telegram",
    });
    expect(d.id).toBe("delivery-1");
  });

  test("updates delivery status and destinationMessageId", () => {
    const req = createRequest();
    const delivery = createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
    });

    const updated = updateDelivery(delivery.id, {
      status: "sent",
      destinationMessageId: "msg-789",
    });

    expect(updated?.status).toBe("sent");
    expect(updated?.destinationMessageId).toBe("msg-789");
  });

  test("returns null when updating a nonexistent delivery", () => {
    expect(updateDelivery("missing", { status: "sent" })).toBeNull();
  });

  test("deleting a request cascades to its deliveries", () => {
    const req = createRequest();
    createDelivery({ requestId: req.id, destinationChannel: "telegram" });
    createDelivery({ requestId: req.id, destinationChannel: "vellum" });

    getGatewayDb()
      .delete(guardianRequests)
      .where(eq(guardianRequests.id, req.id))
      .run();

    expect(listDeliveries(req.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// By-destination reads
// ---------------------------------------------------------------------------

describe("getPendingByDestinationMessage", () => {
  test("recovers the pending request behind a delivered card message", () => {
    const req = createRequest();
    const other = createRequest();
    createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-1",
    });
    createDelivery({
      requestId: other.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-2",
    });

    expect(
      getPendingByDestinationMessage("telegram", "chat-1", "msg-1")?.id,
    ).toBe(req.id);
    expect(
      getPendingByDestinationMessage("telegram", "chat-1", "msg-3"),
    ).toBeNull();
    expect(
      getPendingByDestinationMessage("slack", "chat-1", "msg-1"),
    ).toBeNull();
  });

  test("returns null when the matched request is no longer pending", () => {
    const req = createRequest();
    createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-1",
    });
    resolveGuardianRequest(req.id, "pending", { status: "approved" });

    expect(
      getPendingByDestinationMessage("telegram", "chat-1", "msg-1"),
    ).toBeNull();
  });
});

describe("listPendingByDestinationChat", () => {
  test("returns pending requests for the (channel, chatId) pair, deduplicated", () => {
    const pending = createRequest();
    const resolved = createRequest();
    updateGuardianRequest(resolved.id, { status: "approved" });

    createDelivery({
      requestId: pending.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-1",
    });
    createDelivery({
      requestId: pending.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-2",
    });
    createDelivery({
      requestId: resolved.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
    });

    const results = listPendingByDestinationChat("telegram", "chat-1");
    expect(results.map((r) => r.id)).toEqual([pending.id]);
    expect(listPendingByDestinationChat("phone", "chat-1")).toHaveLength(0);
    expect(listPendingByDestinationChat("telegram", "chat-2")).toHaveLength(0);
  });
});

describe("listPendingByDestinationConversation", () => {
  test("returns pending requests, optionally scoped by channel", () => {
    const pending = createRequest();
    const resolved = createRequest();
    updateGuardianRequest(resolved.id, { status: "approved" });

    createDelivery({
      requestId: pending.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });
    createDelivery({
      requestId: resolved.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    expect(
      listPendingByDestinationConversation("conv-1").map((r) => r.id),
    ).toEqual([pending.id]);
    expect(
      listPendingByDestinationConversation("conv-1", "vellum").map((r) => r.id),
    ).toEqual([pending.id]);
    expect(
      listPendingByDestinationConversation("conv-1", "telegram"),
    ).toHaveLength(0);
  });

  test("deduplicates multiple deliveries for the same request", () => {
    const req = createRequest();
    createDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });
    createDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-1",
    });

    expect(listPendingByDestinationConversation("conv-1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conversation scope
// ---------------------------------------------------------------------------

describe("listPendingByConversationScope", () => {
  test("unions source-conversation and delivery-destination matches", () => {
    const bySource = createRequest({ sourceConversationId: "conv-1" });
    const byDelivery = createRequest();
    createDelivery({
      requestId: byDelivery.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });
    const both = createRequest({ sourceConversationId: "conv-1" });
    createDelivery({
      requestId: both.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    const results = listPendingByConversationScope("conv-1");
    expect(results.map((r) => r.id).sort()).toEqual(
      [bySource.id, byDelivery.id, both.id].sort(),
    );
  });

  test("filters expired requests and honors the channel scope", () => {
    createRequest({ sourceConversationId: "conv-1", expiresAt: PAST() });
    const fresh = createRequest({
      sourceConversationId: "conv-1",
      expiresAt: FUTURE(),
    });
    const otherChannel = createRequest();
    createDelivery({
      requestId: otherChannel.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-1",
    });

    const results = listPendingByConversationScope("conv-1", "vellum");
    expect(results.map((r) => r.id)).toEqual([fresh.id]);
  });
});

describe("isRequestInConversationScope", () => {
  test("matches the source conversation and delivery destinations", () => {
    const req = createRequest({ sourceConversationId: "access-req-src" });
    createDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "guardian-chat",
      destinationConversationId: "guardian-conv",
    });

    expect(isRequestInConversationScope(req.id, "access-req-src")).toBe(true);
    expect(isRequestInConversationScope(req.id, "guardian-conv")).toBe(true);
    expect(isRequestInConversationScope(req.id, "guardian-conv", "slack")).toBe(
      true,
    );
    expect(
      isRequestInConversationScope(req.id, "guardian-conv", "telegram"),
    ).toBe(false);
    expect(isRequestInConversationScope(req.id, "unrelated-conv")).toBe(false);
    expect(isRequestInConversationScope("missing", "guardian-conv")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Call-controller convenience reads
// ---------------------------------------------------------------------------

describe("getPendingByCallSessionId", () => {
  test("returns the most recent pending request for the call session", () => {
    const db = getGatewayDb();
    const now = Date.now();
    for (const [id, createdAt, status] of [
      ["older", now - 2000, "pending"],
      ["newest", now, "pending"],
      ["resolved", now + 1000, "approved"],
    ] as const) {
      db.insert(guardianRequests)
        .values({
          id,
          kind: "pending_question",
          callSessionId: "call-1",
          guardianPrincipalId: TEST_PRINCIPAL,
          status,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    }

    expect(getPendingByCallSessionId("call-1")?.id).toBe("newest");
    expect(getPendingByCallSessionId("call-2")).toBeNull();
  });
});

describe("getByPendingQuestionId", () => {
  test("finds the request linked to a pending question", () => {
    const req = createRequest({
      kind: "pending_question",
      pendingQuestionId: "pq-1",
    });

    expect(getByPendingQuestionId("pq-1")?.id).toBe(req.id);
    expect(getByPendingQuestionId("pq-2")).toBeNull();
  });
});
