/**
 * Tests for `updateDelivery`, the per-surface delivery-row patch.
 *
 * Pins the terminal-receipt invariant: `withdrawn` is the daemon's receipt
 * that a card was durably withdrawn, and a later status patch never
 * overwrites it. Delivery recording lands its sent/failed status after the
 * notification broadcast settles, so a decision racing that window would
 * otherwise re-describe an already-withdrawn card as live (LUM-3489).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DELIVERY_STATUS } from "@vellumai/gateway-client";

import "./test-preload.js";

const { initGatewayDb, resetGatewayDb } = await import("../db/connection.js");
const {
  createDelivery,
  createGuardianRequest,
  listDeliveries,
  updateDelivery,
} = await import("../db/guardian-request-store.js");

let reqSeq = 0;

function seedRequest() {
  return createGuardianRequest({
    id: `req-${++reqSeq}`,
    kind: "tool_approval",
    sourceChannel: "slack",
    guardianPrincipalId: "principal-1",
  });
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
});

describe("updateDelivery", () => {
  test("patches status and destinationMessageId on a live row", () => {
    const request = seedRequest();
    const delivery = createDelivery({
      requestId: request.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
    });

    const updated = updateDelivery(delivery.id, {
      status: DELIVERY_STATUS.sent,
      destinationMessageId: "1700000000.0001",
    });

    expect(updated?.status).toBe(DELIVERY_STATUS.sent);
    expect(updated?.destinationMessageId).toBe("1700000000.0001");
  });

  test("a status patch never overwrites the withdrawn receipt", () => {
    const request = seedRequest();
    const delivery = createDelivery({
      requestId: request.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      destinationMessageId: "1700000000.0001",
    });

    // The decision's withdrawal pass receipts the surface...
    updateDelivery(delivery.id, { status: DELIVERY_STATUS.withdrawn });
    // ...then the recorder's post-broadcast status patch lands late.
    const updated = updateDelivery(delivery.id, {
      status: DELIVERY_STATUS.sent,
    });

    expect(updated?.status).toBe(DELIVERY_STATUS.withdrawn);
    const [row] = listDeliveries(request.id);
    expect(row.status).toBe(DELIVERY_STATUS.withdrawn);
  });

  test("non-status fields still patch a withdrawn row", () => {
    const request = seedRequest();
    const delivery = createDelivery({
      requestId: request.id,
      destinationChannel: "slack",
      destinationChatId: "C1",
      status: DELIVERY_STATUS.withdrawn,
    });

    const updated = updateDelivery(delivery.id, {
      destinationMessageId: "1700000000.0002",
    });

    expect(updated?.status).toBe(DELIVERY_STATUS.withdrawn);
    expect(updated?.destinationMessageId).toBe("1700000000.0002");
  });
});
