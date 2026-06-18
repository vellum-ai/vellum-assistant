import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

const completeSurfaceAndNotify = mock(() => {});
mock.module("../daemon/conversation-surfaces.js", () => ({
  completeSurfaceAndNotify,
}));

const withdrawSlackApprovalCard = mock(
  async (_params: Record<string, unknown>) => {},
);
mock.module("../messaging/providers/slack/withdraw.js", () => ({
  withdrawSlackApprovalCard,
}));

import { withdrawGuardianRequestCards } from "../approvals/guardian-card-withdrawal.js";
import {
  type CanonicalGuardianRequest,
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
} from "../memory/canonical-guardian-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { recordCanonicalChannelDelivery } from "../notifications/canonical-delivery-recorder.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";

initializeDb();

const PRINCIPAL_ID = "withdrawal-test-principal";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

function makeRequest(
  overrides: Partial<Parameters<typeof createCanonicalGuardianRequest>[0]> = {},
): CanonicalGuardianRequest {
  return createCanonicalGuardianRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "slack",
    guardianPrincipalId: PRINCIPAL_ID,
    ...overrides,
  });
}

describe("withdrawGuardianRequestCards", () => {
  beforeEach(() => {
    resetTables();
    completeSurfaceAndNotify.mockClear();
    withdrawSlackApprovalCard.mockClear();
  });

  test("withdraws + broadcasts the in-app card when the decision came from another surface", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "slack",
    });

    expect(completeSurfaceAndNotify).toHaveBeenCalledTimes(1);
    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-1",
      `access-request-${req.id}`,
      "Approved",
    );
  });

  test("skips the in-app card when the decision originated in-app", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "vellum",
    });

    // The acting in-app client already completed its own card optimistically.
    expect(completeSurfaceAndNotify).not.toHaveBeenCalled();
  });

  test("withdraws the Slack card with decider and decision time", async () => {
    const req = makeRequest({ decidedByExternalUserId: "U-guardian" });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C123",
      destinationMessageId: "1700000000.0001",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "denied",
      originChannel: "vellum",
    });

    expect(withdrawSlackApprovalCard).toHaveBeenCalledTimes(1);
    const [params] = withdrawSlackApprovalCard.mock.calls[0];
    expect(params).toMatchObject({
      channel: "C123",
      messageTs: "1700000000.0001",
      status: "denied",
      decidedByExternalUserId: "U-guardian",
    });
    expect(typeof (params as { decidedAtMs?: number }).decidedAtMs).toBe(
      "number",
    );
  });

  test("skips the Slack edit when no channel message id was captured", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C123",
    });

    await withdrawGuardianRequestCards({ request: req, status: "approved" });

    expect(withdrawSlackApprovalCard).not.toHaveBeenCalled();
  });

  test("withdraws every surface (including in-app broadcast) when no origin channel", async () => {
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      destinationMessageId: "1.0",
    });

    await withdrawGuardianRequestCards({ request: req, status: "expired" });

    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-1",
      `access-request-${req.id}`,
      "Expired",
    );
    expect(withdrawSlackApprovalCard).toHaveBeenCalledTimes(1);
  });

  test("ignores channels without in-place edit support (telegram)", async () => {
    const req = makeRequest({ sourceChannel: "telegram" });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "telegram",
      destinationChatId: "T1",
      destinationMessageId: "9",
    });

    await withdrawGuardianRequestCards({ request: req, status: "approved" });

    expect(withdrawSlackApprovalCard).not.toHaveBeenCalled();
    expect(completeSurfaceAndNotify).not.toHaveBeenCalled();
  });

  test("is best-effort: a failing surface never blocks the others or throws", async () => {
    withdrawSlackApprovalCard.mockImplementationOnce(async () => {
      throw new Error("slack unavailable");
    });
    const req = makeRequest();
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      destinationMessageId: "1.0",
    });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await expect(
      withdrawGuardianRequestCards({
        request: req,
        status: "approved",
        originChannel: "telegram",
      }),
    ).resolves.toBeUndefined();

    // The in-app card was still withdrawn despite the Slack failure.
    expect(completeSurfaceAndNotify).toHaveBeenCalledTimes(1);
  });

  test("tool-approval cards resolve to the tool-approval surface id", async () => {
    const req = makeRequest({ kind: "tool_approval", toolName: "shell" });
    createCanonicalGuardianDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });

    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "telegram",
    });

    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-1",
      `tool-approval-${req.id}`,
      "Approved",
    );
  });
});

describe("recordCanonicalChannelDelivery", () => {
  beforeEach(() => {
    resetTables();
    withdrawSlackApprovalCard.mockClear();
  });

  test("captures the channel-native message id so the card can be withdrawn", async () => {
    const req = makeRequest();
    const result: NotificationDeliveryResult = {
      channel: "slack",
      destination: "C999",
      status: "sent",
      messageId: "1700000000.1234",
    };

    const delivery = recordCanonicalChannelDelivery(req.id, result);

    expect(delivery.destinationChannel).toBe("slack");
    expect(delivery.destinationChatId).toBe("C999");
    expect(delivery.destinationMessageId).toBe("1700000000.1234");

    // End-to-end: the recorded delivery is now editable by the withdrawal path.
    await withdrawGuardianRequestCards({
      request: req,
      status: "approved",
      originChannel: "vellum",
    });
    const [params] = withdrawSlackApprovalCard.mock.calls[0];
    expect((params as { messageTs?: string }).messageTs).toBe(
      "1700000000.1234",
    );
  });

  test("omits chat id when the destination is empty", () => {
    const req = makeRequest();
    const delivery = recordCanonicalChannelDelivery(req.id, {
      channel: "slack",
      destination: "",
      status: "sent",
    });
    expect(delivery.destinationChatId).toBeNull();
    expect(listCanonicalGuardianDeliveries(req.id)).toHaveLength(1);
  });
});
