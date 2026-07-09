/**
 * Tests for the gateway-backed guardian-request client.
 *
 * The IPC transport is stubbed; wrappers are exercised for method/param
 * mapping, contract-schema validation of responses, and error posture:
 * lifecycle writes throw fail-closed, while the `...OrNull` / `...OrEmpty` /
 * `...OrFalse` read variants log and degrade to the empty value.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  GuardianRequestDeliveryWire,
  GuardianRequestWire,
} from "@vellumai/gateway-client";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcResponse: unknown;
let ipcError: Error | null = null;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) {
      throw ipcError;
    }
    return ipcResponse;
  },
);
const actualGatewayClient = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Delegating logger mock: only the client's own logger has its `warn`
// captured; every other module keeps its real logger.
let warnCalls: unknown[][] = [];
const actualLoggerModule = await import("../../util/logger.js");
// Captured before mock.module: the namespace binding is live post-mock.
const realGetLogger = actualLoggerModule.getLogger;
mock.module("../../util/logger.js", () => ({
  ...actualLoggerModule,
  getLogger: (name: string) => {
    const logger = realGetLogger(name);
    if (name !== "gateway-guardian-requests") {
      return logger;
    }
    return new Proxy(logger, {
      get(target, prop, receiver) {
        if (prop === "warn") {
          return (...args: unknown[]) => {
            warnCalls.push(args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  },
}));

const client = await import("../gateway-guardian-requests.js");

function makeWireRequest(
  overrides: Partial<GuardianRequestWire> = {},
): GuardianRequestWire {
  return {
    id: "req-1",
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "telegram",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "user-123",
    requesterChatId: "chat-456",
    guardianExternalUserId: "guardian-789",
    guardianPrincipalId: "principal-1",
    callSessionId: null,
    pendingQuestionId: null,
    questionText: null,
    requestCode: "AB12",
    toolName: null,
    inputDigest: null,
    commandPreview: null,
    riskLevel: null,
    activityText: "wants to chat",
    executionTarget: null,
    requesterSignals: null,
    requestTrigger: "denied",
    status: "pending",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: null,
    expiresAt: 1_700_000_600_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeWireDelivery(
  overrides: Partial<GuardianRequestDeliveryWire> = {},
): GuardianRequestDeliveryWire {
  return {
    id: "del-1",
    requestId: "req-1",
    destinationChannel: "telegram",
    destinationConversationId: null,
    destinationChatId: "chat-456",
    destinationMessageId: "msg-1",
    status: "sent",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  ipcCalls = [];
  ipcResponse = undefined;
  ipcError = null;
  warnCalls = [];
});

describe("createGuardianRequest", () => {
  test("passes create params through and returns the created wire DTO", async () => {
    const created = makeWireRequest();
    ipcResponse = created;

    const result = await client.createGuardianRequest({
      id: "req-1",
      kind: "access_request",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      requesterExternalUserId: "user-123",
      guardianPrincipalId: "principal-1",
      requestTrigger: "denied",
    });

    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_create",
        params: {
          id: "req-1",
          kind: "access_request",
          sourceChannel: "telegram",
          sourceConversationId: "conv-1",
          requesterExternalUserId: "user-123",
          guardianPrincipalId: "principal-1",
          requestTrigger: "denied",
        },
      },
    ]);
    expect(result).toEqual(created);
  });

  test("throws on transport failure (fail-closed)", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.createGuardianRequest({
        id: "req-1",
        kind: "access_request",
        guardianPrincipalId: "principal-1",
      }),
    ).rejects.toThrow("gateway unavailable");
  });

  test("throws on a malformed response", async () => {
    ipcResponse = { id: "req-1" };
    await expect(
      client.createGuardianRequest({
        id: "req-1",
        kind: "access_request",
        guardianPrincipalId: "principal-1",
      }),
    ).rejects.toThrow("guardian_requests_create");
  });
});

describe("decideGuardianRequest", () => {
  test("round-trips a decision with an ACL outcome", async () => {
    const decided = makeWireRequest({
      status: "approved",
      decidedByPrincipalId: "principal-1",
    });
    ipcResponse = { applied: true, request: decided };

    const result = await client.decideGuardianRequest({
      id: "req-1",
      expectedStatus: "pending",
      status: "approved",
      decidedByPrincipalId: "principal-1",
      answerText: "approved",
      aclOutcome: {
        type: "activate_member",
        sourceChannel: "telegram",
        externalUserId: "user-123",
        externalChatId: "chat-456",
        displayName: "Alice",
        verifiedVia: "guardian_approval",
      },
    });

    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_decide",
        params: {
          id: "req-1",
          expectedStatus: "pending",
          status: "approved",
          decidedByPrincipalId: "principal-1",
          answerText: "approved",
          aclOutcome: {
            type: "activate_member",
            sourceChannel: "telegram",
            externalUserId: "user-123",
            externalChatId: "chat-456",
            displayName: "Alice",
            verifiedVia: "guardian_approval",
          },
        },
      },
    ]);
    expect(result).toEqual({ applied: true, request: decided });
  });

  test("passes the minted outbound session back on a mint outcome", async () => {
    const mintedSession = {
      sessionId: "sess-1",
      secret: "123456",
      challengeHash: "a".repeat(64),
      expiresAt: 1_700_000_600_000,
      ttlSeconds: 600,
    };
    ipcResponse = {
      applied: true,
      request: makeWireRequest({ status: "approved" }),
      mintedSession,
    };

    const result = await client.decideGuardianRequest({
      id: "req-1",
      expectedStatus: "pending",
      status: "approved",
      aclOutcome: {
        type: "mint_outbound_session",
        channel: "phone",
        expectedPhoneE164: "+15555550123",
        destinationAddress: "+15555550123",
        codeDigits: 6,
        verificationPurpose: "guardian",
      },
    });

    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.mintedSession).toEqual(mintedSession);
    }
    expect(ipcCalls[0]?.params?.aclOutcome).toEqual({
      type: "mint_outbound_session",
      channel: "phone",
      expectedPhoneE164: "+15555550123",
      destinationAddress: "+15555550123",
      codeDigits: 6,
      verificationPurpose: "guardian",
    });
  });

  test("passes the CAS-miss conflict marker through", async () => {
    ipcResponse = { applied: false, reason: "status_conflict" };
    const result = await client.decideGuardianRequest({
      id: "req-1",
      expectedStatus: "pending",
      status: "denied",
    });
    expect(result).toEqual({ applied: false, reason: "status_conflict" });
  });

  test("throws on transport failure — a decision must never fake success", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.decideGuardianRequest({
        id: "req-1",
        expectedStatus: "pending",
        status: "approved",
      }),
    ).rejects.toThrow("gateway unavailable");
  });

  test("throws on a malformed response", async () => {
    ipcResponse = { applied: true };
    await expect(
      client.decideGuardianRequest({
        id: "req-1",
        expectedStatus: "pending",
        status: "approved",
      }),
    ).rejects.toThrow("guardian_requests_decide");
  });
});

describe("request lookups", () => {
  test("getGuardianRequest maps the method and returns the DTO or null", async () => {
    const request = makeWireRequest();
    ipcResponse = request;
    expect(await client.getGuardianRequest("req-1")).toEqual(request);
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_get",
      params: { id: "req-1" },
    });

    ipcResponse = null;
    expect(await client.getGuardianRequest("req-404")).toBeNull();
  });

  test("getGuardianRequestByCode maps the method and params", async () => {
    const request = makeWireRequest();
    ipcResponse = request;
    expect(await client.getGuardianRequestByCode("AB12")).toEqual(request);
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_get_by_code",
      params: { code: "AB12" },
    });
  });

  test("getPendingRequestByDestinationMessage maps the destination triple", async () => {
    ipcResponse = null;
    expect(
      await client.getPendingRequestByDestinationMessage(
        "telegram",
        "chat-456",
        "msg-1",
      ),
    ).toBeNull();
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_get_by_destination_message",
      params: { channel: "telegram", chatId: "chat-456", messageId: "msg-1" },
    });
  });

  test("getPendingRequestByCallSession and getRequestByPendingQuestion map params", async () => {
    const request = makeWireRequest({ callSessionId: "call-1" });
    ipcResponse = request;
    expect(await client.getPendingRequestByCallSession("call-1")).toEqual(
      request,
    );
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_get_by_call_session",
      params: { callSessionId: "call-1" },
    });

    ipcResponse = makeWireRequest({ pendingQuestionId: "pq-1" });
    await client.getRequestByPendingQuestion("pq-1");
    expect(ipcCalls[1]).toEqual({
      method: "guardian_requests_get_by_pending_question",
      params: { pendingQuestionId: "pq-1" },
    });
  });

  test("throwing lookups throw on a malformed payload", async () => {
    ipcResponse = { id: "req-1" };
    await expect(client.getGuardianRequest("req-1")).rejects.toThrow(
      "guardian_requests_get",
    );
    await expect(client.getGuardianRequestByCode("AB12")).rejects.toThrow(
      "guardian_requests_get_by_code",
    );
  });

  test("OrNull variants degrade to null and log instead of throwing", async () => {
    ipcResponse = { id: "req-1" };
    expect(await client.getGuardianRequestOrNull("req-1")).toBeNull();
    expect(warnCalls).toHaveLength(1);

    ipcError = new Error("gateway unavailable");
    expect(await client.getGuardianRequestByCodeOrNull("AB12")).toBeNull();
    expect(
      await client.getPendingRequestByDestinationMessageOrNull(
        "telegram",
        "chat-456",
        "msg-1",
      ),
    ).toBeNull();
    expect(
      await client.getPendingRequestByCallSessionOrNull("call-1"),
    ).toBeNull();
    expect(await client.getRequestByPendingQuestionOrNull("pq-1")).toBeNull();
    expect(warnCalls).toHaveLength(5);
  });

  test("OrNull variants pass successful reads through untouched", async () => {
    const request = makeWireRequest();
    ipcResponse = request;
    expect(await client.getGuardianRequestOrNull("req-1")).toEqual(request);
    expect(warnCalls).toHaveLength(0);
  });
});

describe("request lists", () => {
  test("listGuardianRequests passes filters through and validates the array", async () => {
    const requests = [makeWireRequest(), makeWireRequest({ id: "req-2" })];
    ipcResponse = requests;

    const result = await client.listGuardianRequests({
      status: "pending",
      guardianPrincipalId: "principal-1",
      sourceType: "channel",
    });

    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_list",
        params: {
          status: "pending",
          guardianPrincipalId: "principal-1",
          sourceType: "channel",
        },
      },
    ]);
    expect(result).toEqual(requests);
  });

  test("listPendingRequestsByDestination and listPendingRequestsByScope map params", async () => {
    ipcResponse = [];
    await client.listPendingRequestsByDestination({
      channel: "telegram",
      chatId: "chat-456",
    });
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_list_pending_by_destination",
      params: { channel: "telegram", chatId: "chat-456" },
    });

    await client.listPendingRequestsByScope("conv-1", "telegram");
    expect(ipcCalls[1]).toEqual({
      method: "guardian_requests_list_pending_by_scope",
      params: { conversationId: "conv-1", channel: "telegram" },
    });
  });

  test("throwing lists throw on transport failure and malformed payloads", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(client.listGuardianRequests()).rejects.toThrow(
      "gateway unavailable",
    );

    ipcError = null;
    ipcResponse = [{ id: "req-1" }];
    await expect(client.listGuardianRequests()).rejects.toThrow(
      "guardian_requests_list",
    );
  });

  test("OrEmpty variants degrade to [] and log instead of throwing", async () => {
    ipcError = new Error("gateway unavailable");
    expect(await client.listGuardianRequestsOrEmpty()).toEqual([]);
    expect(
      await client.listPendingRequestsByDestinationOrEmpty({
        conversationId: "conv-1",
      }),
    ).toEqual([]);
    expect(await client.listPendingRequestsByScopeOrEmpty("conv-1")).toEqual(
      [],
    );
    expect(warnCalls).toHaveLength(3);
  });
});

describe("mutations", () => {
  test("updateGuardianRequest sends the id and patch and resolves on ok", async () => {
    ipcResponse = { ok: true };
    await client.updateGuardianRequest("req-1", {
      status: "cancelled",
      followupState: null,
    });
    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_update",
        params: {
          id: "req-1",
          patch: { status: "cancelled", followupState: null },
        },
      },
    ]);
  });

  test("reopenGuardianRequest and expireGuardianRequest map params", async () => {
    ipcResponse = { ok: true };
    await client.reopenGuardianRequest("req-1", "expired");
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_reopen",
      params: { id: "req-1", fromStatus: "expired" },
    });

    await client.expireGuardianRequest("req-1");
    expect(ipcCalls[1]).toEqual({
      method: "guardian_requests_expire",
      params: { id: "req-1" },
    });
  });

  test("mutations throw on transport failure (fail-closed)", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.updateGuardianRequest("req-1", { status: "cancelled" }),
    ).rejects.toThrow("gateway unavailable");
    await expect(client.expireGuardianRequest("req-1")).rejects.toThrow(
      "gateway unavailable",
    );
  });

  test("mutations throw when the gateway does not ack ok", async () => {
    ipcResponse = { ok: false };
    await expect(
      client.reopenGuardianRequest("req-1", "expired"),
    ).rejects.toThrow("guardian_requests_reopen");
  });
});

describe("expiry lifecycle", () => {
  test("expireInteractionBoundGuardianRequests returns the expired count", async () => {
    ipcResponse = { expired: 3 };
    expect(await client.expireInteractionBoundGuardianRequests()).toBe(3);
    expect(ipcCalls).toEqual([
      { method: "guardian_requests_expire_interaction_bound", params: {} },
    ]);
  });

  test("sweepExpiredGuardianRequests passes now and returns the expired ids", async () => {
    ipcResponse = { expired: ["req-1", "req-2"] };
    expect(
      await client.sweepExpiredGuardianRequests(1_700_000_500_000),
    ).toEqual(["req-1", "req-2"]);
    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_sweep_expired",
        params: { now: 1_700_000_500_000 },
      },
    ]);
  });

  test("sweeps throw on transport failure and malformed responses", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(client.sweepExpiredGuardianRequests()).rejects.toThrow(
      "gateway unavailable",
    );

    ipcError = null;
    ipcResponse = { expired: 3 };
    await expect(client.sweepExpiredGuardianRequests()).rejects.toThrow(
      "guardian_requests_sweep_expired",
    );
  });
});

describe("deliveries", () => {
  test("createGuardianRequestDelivery returns the created delivery", async () => {
    const delivery = makeWireDelivery();
    ipcResponse = delivery;

    const result = await client.createGuardianRequestDelivery({
      requestId: "req-1",
      destinationChannel: "telegram",
      destinationChatId: "chat-456",
      status: "sent",
    });

    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_create_delivery",
        params: {
          requestId: "req-1",
          destinationChannel: "telegram",
          destinationChatId: "chat-456",
          status: "sent",
        },
      },
    ]);
    expect(result).toEqual(delivery);
  });

  test("createGuardianRequestDelivery throws on a malformed response", async () => {
    ipcResponse = { id: "del-1" };
    await expect(
      client.createGuardianRequestDelivery({
        requestId: "req-1",
        destinationChannel: "telegram",
      }),
    ).rejects.toThrow("guardian_requests_create_delivery");
  });

  test("updateGuardianRequestDelivery sends the id and patch", async () => {
    ipcResponse = { ok: true };
    await client.updateGuardianRequestDelivery("del-1", {
      status: "delivered",
      destinationMessageId: "msg-2",
    });
    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_update_delivery",
        params: {
          id: "del-1",
          patch: { status: "delivered", destinationMessageId: "msg-2" },
        },
      },
    ]);
  });

  test("listGuardianRequestDeliveries validates the array; OrEmpty degrades", async () => {
    const deliveries = [makeWireDelivery()];
    ipcResponse = deliveries;
    expect(await client.listGuardianRequestDeliveries("req-1")).toEqual(
      deliveries,
    );
    expect(ipcCalls[0]).toEqual({
      method: "guardian_requests_list_deliveries",
      params: { requestId: "req-1" },
    });

    ipcError = new Error("gateway unavailable");
    await expect(client.listGuardianRequestDeliveries("req-1")).rejects.toThrow(
      "gateway unavailable",
    );
    expect(await client.listGuardianRequestDeliveriesOrEmpty("req-1")).toEqual(
      [],
    );
    expect(warnCalls).toHaveLength(1);
  });
});

describe("isGuardianRequestInScope", () => {
  test("returns the gateway scope verdict", async () => {
    ipcResponse = { inScope: true };
    expect(
      await client.isGuardianRequestInScope("req-1", "conv-1", "telegram"),
    ).toBe(true);
    expect(ipcCalls).toEqual([
      {
        method: "guardian_requests_in_scope",
        params: {
          requestId: "req-1",
          conversationId: "conv-1",
          channel: "telegram",
        },
      },
    ]);

    ipcResponse = { inScope: false };
    expect(await client.isGuardianRequestInScope("req-1", "conv-2")).toBe(
      false,
    );
  });

  test("throws on a malformed response; OrFalse degrades to not-in-scope", async () => {
    ipcResponse = { allowed: true };
    await expect(
      client.isGuardianRequestInScope("req-1", "conv-1"),
    ).rejects.toThrow("guardian_requests_in_scope");

    ipcError = new Error("gateway unavailable");
    expect(
      await client.isGuardianRequestInScopeOrFalse("req-1", "conv-1"),
    ).toBe(false);
    expect(warnCalls).toHaveLength(1);
  });
});
