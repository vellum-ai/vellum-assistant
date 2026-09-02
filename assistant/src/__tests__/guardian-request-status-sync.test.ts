import { beforeEach, describe, expect, mock, test } from "bun:test";

const completeSurfaceAndNotify = mock(() => true);
const markSurfaceCompleted = mock(() => true);
mock.module("../daemon/conversation-surfaces.js", () => ({
  completeSurfaceAndNotify,
  markSurfaceCompleted,
}));

const withdrawSlackApprovalCard = mock(
  async (_params: Record<string, unknown>) => {},
);
mock.module("../messaging/providers/slack/withdraw.js", () => ({
  withdrawSlackApprovalCard,
}));

const withdrawDiscordApprovalCard = mock(async (_params: unknown) => undefined);
mock.module("../messaging/providers/discord/withdraw.js", () => ({
  withdrawDiscordApprovalCard,
}));

const withdrawTelegramApprovalCard = mock(
  async (_params: Record<string, unknown>) => ({ complete: true }),
);
mock.module("../messaging/providers/telegram-bot/withdraw.js", () => ({
  withdrawTelegramApprovalCard,
}));

import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import { syncTerminalGuardianRequestStatus } from "../approvals/guardian-request-status-sync.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const PRINCIPAL_ID = "status-sync-test-principal";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return bridgeState.seedRequest({
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "slack",
    toolName: "shell",
    guardianPrincipalId: PRINCIPAL_ID,
    ...overrides,
  });
}

function deliveriesFor(requestId: string) {
  return bridgeState.deliveries.filter((d) => d.requestId === requestId);
}

describe("syncTerminalGuardianRequestStatus", () => {
  beforeEach(() => {
    bridgeState.reset();
    completeSurfaceAndNotify.mockClear();
    markSurfaceCompleted.mockClear();
    withdrawSlackApprovalCard.mockClear();
  });

  test("a landed CAS withdraws every delivered projection", async () => {
    const req = makeRequest();
    const vellum = bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-thread",
    });
    const slack = bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      destinationMessageId: "1.0",
      destinationConversationId: "conv-dm",
    });

    await syncTerminalGuardianRequestStatus({
      requestId: req.id,
      status: "approved",
      syncContext: "test",
    });

    expect(bridgeState.requests.get(req.id)?.status).toBe("approved");
    // Both in-app projections converge live (no origin channel: the acting
    // surface was the confirmation prompt, never the card).
    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-thread",
      `tool-approval-${req.id}`,
      "Approved",
    );
    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-dm",
      `tool-approval-${req.id}`,
      "Approved",
    );
    expect(withdrawSlackApprovalCard).toHaveBeenCalledTimes(1);
    const byId = new Map(deliveriesFor(req.id).map((d) => [d.id, d.status]));
    expect(byId.get(vellum.id)).toBe("withdrawn");
    expect(byId.get(slack.id)).toBe("withdrawn");
  });

  test("a denial renders Denied on the withdrawn cards", async () => {
    const req = makeRequest();
    bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-thread",
    });

    await syncTerminalGuardianRequestStatus({
      requestId: req.id,
      status: "denied",
      syncContext: "test",
    });

    expect(bridgeState.requests.get(req.id)?.status).toBe("denied");
    expect(completeSurfaceAndNotify).toHaveBeenCalledWith(
      "conv-thread",
      `tool-approval-${req.id}`,
      "Denied",
    );
  });

  test("a CAS miss leaves withdrawal to the path that resolved the request", async () => {
    const req = makeRequest({ status: "approved" });
    bridgeState.seedDelivery({
      requestId: req.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-thread",
    });

    await syncTerminalGuardianRequestStatus({
      requestId: req.id,
      status: "approved",
      syncContext: "test",
    });

    expect(completeSurfaceAndNotify).not.toHaveBeenCalled();
    expect(withdrawSlackApprovalCard).not.toHaveBeenCalled();
  });

  test("never throws when the gateway is unreachable", async () => {
    const req = makeRequest();
    bridgeState.state.decideError = new Error("gateway down");
    await expect(
      syncTerminalGuardianRequestStatus({
        requestId: req.id,
        status: "approved",
        syncContext: "test",
      }),
    ).resolves.toBeUndefined();
    bridgeState.state.decideError = null;
    expect(completeSurfaceAndNotify).not.toHaveBeenCalled();
  });
});
