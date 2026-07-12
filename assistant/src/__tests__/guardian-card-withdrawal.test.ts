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

// The recorder writes through the gateway client; serve that surface from
// the in-memory sim the assertions read.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import { withdrawGuardianRequestCards } from "../approvals/guardian-card-withdrawal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/canonical-delivery-recorder.js";
import { initializeDb } from "../persistence/db-init.js";
import type { SimGuardianRequest } from "./guardian-gateway-sim.js";

await initializeDb();

const PRINCIPAL_ID = "withdrawal-test-principal";

function makeRequest(
  overrides: Partial<SimGuardianRequest> = {},
): SimGuardianRequest {
  return bridgeState.seedRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "slack",
    guardianPrincipalId: PRINCIPAL_ID,
    ...overrides,
  });
}

function deliveriesFor(requestId: string) {
  return bridgeState.deliveries.filter((d) => d.requestId === requestId);
}

describe("withdrawGuardianRequestCards", () => {
  beforeEach(() => {
    bridgeState.reset();
    completeSurfaceAndNotify.mockClear();
    withdrawSlackApprovalCard.mockClear();
  });

  test("withdraws + broadcasts the in-app card when the decision came from another surface", async () => {
    const req = makeRequest();
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C123",
    });

    await withdrawGuardianRequestCards({ request: req, status: "approved" });

    expect(withdrawSlackApprovalCard).not.toHaveBeenCalled();
  });

  test("withdraws every surface (including in-app broadcast) when no origin channel", async () => {
    const req = makeRequest();
    bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
    });
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      destinationMessageId: "1.0",
    });
    bridgeState.seedDelivery({
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
    bridgeState.seedDelivery({
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

describe("recordApprovalCardDelivery", () => {
  beforeEach(() => {
    bridgeState.reset();
  });

  test("records a channel card with its addressing and status", async () => {
    const req = makeRequest();
    const delivery = await recordApprovalCardDelivery({
      requestId: req.id,
      channel: "slack",
      chatId: "C1",
      messageId: "1700000000.0001",
      status: "sent",
    });
    expect(delivery?.destinationChannel).toBe("slack");
    expect(delivery?.destinationChatId).toBe("C1");
    expect(delivery?.destinationMessageId).toBe("1700000000.0001");
    expect(delivery?.status).toBe("sent");
  });

  test("records a vellum card addressed by conversation id, defaulting to pending", async () => {
    const req = makeRequest();
    const delivery = await recordApprovalCardDelivery({
      requestId: req.id,
      channel: "vellum",
      conversationId: "conv-x",
    });
    expect(delivery?.destinationConversationId).toBe("conv-x");
    expect(delivery?.destinationChatId).toBeNull();
    expect(delivery?.status).toBe("pending");
  });

  test("lets a Slack reaction resolve back to its request (LUM-2502)", async () => {
    // A delivered Slack approval card must be addressable by (channel, chat, ts)
    // so an emoji reaction on it resolves to the right request rather than
    // silently falling through to transcript persistence.
    const req = makeRequest();
    await recordApprovalCardDelivery({
      requestId: req.id,
      channel: "slack",
      chatId: "C-guardian",
      messageId: "1700000000.5678",
      status: "sent",
    });

    const resolved =
      await bridgeState.module.getPendingRequestByDestinationMessage(
        "slack",
        "C-guardian",
        "1700000000.5678",
      );
    expect(resolved?.id).toBe(req.id);
  });
});

describe("recordGuardianRequestDeliveries", () => {
  beforeEach(() => {
    bridgeState.reset();
    withdrawSlackApprovalCard.mockClear();
  });

  test("records each delivery with addressing + status and returns the vellum id", async () => {
    const req = makeRequest();
    const vellumId = await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [
        {
          channel: "vellum",
          destination: "",
          status: "sent",
          conversationId: "conv-1",
        },
        {
          channel: "slack",
          destination: "C999",
          status: "sent",
          messageId: "1700000000.1234",
        },
      ],
    });

    const deliveries = deliveriesFor(req.id);
    expect(deliveries).toHaveLength(2);
    const vellum = deliveries.find((d) => d.destinationChannel === "vellum");
    const slack = deliveries.find((d) => d.destinationChannel === "slack");
    expect(vellumId).toBe(vellum?.id);
    expect(vellum?.destinationConversationId).toBe("conv-1");
    expect(vellum?.status).toBe("sent");
    expect(slack?.destinationChatId).toBe("C999");
    expect(slack?.destinationMessageId).toBe("1700000000.1234");
    expect(slack?.status).toBe("sent");
  });

  test("reuses a pre-created vellum row instead of creating a second", async () => {
    const req = makeRequest();
    const pre = await recordApprovalCardDelivery({
      requestId: req.id,
      channel: "vellum",
      conversationId: "conv-1",
    });

    const vellumId = await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [
        {
          channel: "vellum",
          destination: "",
          status: "sent",
          conversationId: "conv-1",
        },
      ],
      vellumDeliveryId: pre?.id,
    });

    expect(vellumId).toBe(pre?.id);
    const deliveries = deliveriesFor(req.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("sent");
  });

  test("marks a non-sent delivery result as failed (status now tracked for all producers)", async () => {
    const req = makeRequest();
    await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [
        { channel: "slack", destination: "C1", status: "failed" },
      ],
    });
    const [delivery] = deliveriesFor(req.id);
    expect(delivery.status).toBe("failed");
  });

  test("omits chat id when the channel destination is empty", async () => {
    const req = makeRequest();
    await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [{ channel: "slack", destination: "", status: "sent" }],
    });
    const [delivery] = deliveriesFor(req.id);
    expect(delivery.destinationChatId).toBeNull();
  });

  test("records a Slack delivery the withdrawal path can then edit in place", async () => {
    const req = makeRequest();
    await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [
        {
          channel: "slack",
          destination: "C999",
          status: "sent",
          messageId: "1700000000.1234",
        },
      ],
    });

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
});
