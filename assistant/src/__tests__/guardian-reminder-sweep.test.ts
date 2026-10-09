/**
 * Tests for the guardian request reminder sweep.
 *
 * Verifies:
 * 1. runGuardianReminderSweep returns the count of rows the gateway claimed.
 * 2. Delivery routes through guardian_request_deliveries (not sourceChannel +
 *    guardianExternalUserId), so reminders go to the surfaces the original card
 *    was sent to.
 * 3. Deliveries without a chatId or a deliverable route are skipped.
 * 4. Multiple delivery destinations per request each receive a reminder.
 * 5. A gateway fetch failure is logged and returns 0 (skip-round posture).
 * 6. A failed channel delivery is non-fatal (state is already marked by the
 *    gateway; delivery failures do not suppress the count).
 * 7. Stale inline_wait_active markers (e.g. from a daemon crash) are claimed
 *    by the gateway sweep - the daemon sees those rows just like null-state rows.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Delivery sink - captures replies sent via the deliver route.
const deliveredReplies: Array<{
  url: string;
  payload: { chatId: string; text: string; assistantId?: string };
}> = [];
let deliveryError: Error | null = null;
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: { chatId: string; text: string; assistantId?: string },
  ) => {
    if (deliveryError) {
      throw deliveryError;
    }
    deliveredReplies.push({ url, payload });
  },
}));

// Per-request delivery registry: requestId -> delivery records.
const deliveryRegistry = new Map<string, GuardianRequestDeliveryWire[]>();
// Rows the gateway claims and returns this sweep round.
let sweepRows: GuardianRequestWire[] = [];
let gatewayFetchError: Error | null = null;

mock.module("../channels/gateway-guardian-requests.js", () => ({
  sweepPendingGuardianRequestsForReminders: async () => {
    if (gatewayFetchError) {
      throw gatewayFetchError;
    }
    return sweepRows;
  },
  // Degrading variant: failures return [] rather than throwing.
  listGuardianRequestDeliveriesOrEmpty: async (requestId: string) =>
    deliveryRegistry.get(requestId) ?? [],
}));

import type {
  GuardianRequestDeliveryWire,
  GuardianRequestWire,
} from "../channels/gateway-guardian-requests.js";
import { runGuardianReminderSweep } from "../runtime/routes/guardian-reminder-sweep.js";

/** Build a wire request fixture. */
function makeRequest(
  overrides: Partial<GuardianRequestWire> & { kind: string },
): GuardianRequestWire {
  return {
    id: "req-1",
    sourceType: "channel",
    sourceChannel: "slack",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "req-user",
    requesterChatId: "req-chat",
    requestTrigger: null,
    guardianExternalUserId: "G-guardian-user",
    guardianPrincipalId: "guardian-principal",
    callSessionId: null,
    pendingQuestionId: null,
    questionText: null,
    requestCode: "ABC123",
    toolName: null,
    inputDigest: null,
    commandPreview: null,
    riskLevel: null,
    activityText: null,
    executionTarget: null,
    requesterSignals: null,
    status: "pending",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: "reminded",
    expiresAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Build a delivery record fixture. */
function makeDelivery(
  overrides: Partial<GuardianRequestDeliveryWire> & {
    requestId: string;
    destinationChannel: string;
  },
): GuardianRequestDeliveryWire {
  return {
    id: "del-1",
    destinationConversationId: null,
    destinationChatId: "chat-123",
    destinationMessageId: null,
    status: "delivered",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Register delivery records for a request. */
function seedDeliveries(
  requestId: string,
  deliveries: GuardianRequestDeliveryWire[],
): void {
  deliveryRegistry.set(requestId, deliveries);
}

beforeEach(() => {
  deliveredReplies.length = 0;
  deliveryRegistry.clear();
  sweepRows = [];
  deliveryError = null;
  gatewayFetchError = null;
});

describe("runGuardianReminderSweep", () => {
  test("returns 0 and skips when gateway claims nothing", async () => {
    const count = await runGuardianReminderSweep();
    expect(count).toBe(0);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("routes reminder to the recorded delivery destination, not sourceChannel", async () => {
    // Source channel is 'slack' but the original card was delivered to Telegram.
    const req = makeRequest({
      id: "req-a",
      kind: "access_request",
      sourceChannel: "slack",
    });
    sweepRows = [req];
    seedDeliveries("req-a", [
      makeDelivery({
        id: "del-a",
        requestId: "req-a",
        destinationChannel: "telegram",
        destinationChatId: "tg-guardian-chat",
      }),
    ]);

    await runGuardianReminderSweep();

    // Reminder goes to Telegram (the recorded delivery), NOT /deliver/slack.
    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].url).toBe("/deliver/telegram");
    expect(deliveredReplies[0].payload.chatId).toBe("tg-guardian-chat");
    expect(deliveredReplies[0].payload.text).toContain("access request");
    expect(deliveredReplies[0].payload.text).toContain("ABC123");
  });

  test("sends to all delivery destinations independently", async () => {
    const req = makeRequest({
      id: "req-multi",
      kind: "tool_grant_request",
      toolName: "bash",
      requestCode: "TL99",
    });
    sweepRows = [req];
    seedDeliveries("req-multi", [
      makeDelivery({
        id: "del-1",
        requestId: "req-multi",
        destinationChannel: "slack",
        destinationChatId: "UGUARDIAN",
      }),
      makeDelivery({
        id: "del-2",
        requestId: "req-multi",
        destinationChannel: "telegram",
        destinationChatId: "tg-chat",
      }),
    ]);

    await runGuardianReminderSweep();

    expect(deliveredReplies).toHaveLength(2);
    const slackReply = deliveredReplies.find((r) => r.url.includes("slack"));
    const tgReply = deliveredReplies.find((r) => r.url.includes("telegram"));
    expect(slackReply?.payload.chatId).toBe("UGUARDIAN");
    expect(tgReply?.payload.chatId).toBe("tg-chat");
    expect(slackReply?.payload.text).toContain('"bash"');
    expect(tgReply?.payload.text).toContain("TL99");
  });

  test("skips deliveries with no chatId (e.g. vellum in-app)", async () => {
    const req = makeRequest({ id: "req-vellum", kind: "access_request" });
    sweepRows = [req];
    seedDeliveries("req-vellum", [
      makeDelivery({
        id: "del-vellum",
        requestId: "req-vellum",
        destinationChannel: "vellum",
        destinationChatId: null,
        destinationConversationId: "conv-abc",
      }),
    ]);

    const count = await runGuardianReminderSweep();

    // Delivery skipped (vellum has no deliver route + no chatId), but count still 1.
    expect(count).toBe(1);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("no deliveries recorded: count still returned, no delivery attempted", async () => {
    const req = makeRequest({ id: "req-no-del", kind: "access_request" });
    sweepRows = [req];
    // No delivery records seeded.

    const count = await runGuardianReminderSweep();

    expect(count).toBe(1);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("stale inline_wait_active rows are claimed by the gateway and delivered normally", async () => {
    // The gateway already atomically claimed and set followupState = 'reminded';
    // the daemon just sees a normal claimed row and delivers the reminder.
    const req = makeRequest({
      id: "req-stale-inline",
      kind: "tool_grant_request",
      toolName: "bash",
      followupState: "reminded",
    });
    sweepRows = [req];
    seedDeliveries("req-stale-inline", [
      makeDelivery({
        id: "del-si",
        requestId: "req-stale-inline",
        destinationChannel: "slack",
        destinationChatId: "UGUARDIAN",
      }),
    ]);

    const count = await runGuardianReminderSweep();

    expect(count).toBe(1);
    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].payload.text).toContain('"bash"');
  });

  test("gateway fetch failure: logs and returns 0, no deliveries", async () => {
    sweepRows = [makeRequest({ kind: "access_request" })];
    gatewayFetchError = new Error("gateway down");

    const count = await runGuardianReminderSweep();

    expect(count).toBe(0);
    expect(deliveredReplies).toHaveLength(0);
  });

  test("delivery failure is non-fatal; count still returned", async () => {
    const req = makeRequest({ id: "req-fail-del", kind: "access_request" });
    sweepRows = [req];
    seedDeliveries("req-fail-del", [
      makeDelivery({
        id: "del-f",
        requestId: "req-fail-del",
        destinationChannel: "slack",
        destinationChatId: "UGUARDIAN",
      }),
    ]);
    deliveryError = new Error("slack 503");

    const count = await runGuardianReminderSweep();

    // Count reflects gateway's claimed rows, not delivery outcomes.
    expect(count).toBe(1);
  });

  test("returns the total count of claimed requests", async () => {
    sweepRows = [
      makeRequest({ id: "req-a", kind: "access_request" }),
      makeRequest({ id: "req-b", kind: "tool_grant_request" }),
    ];

    const count = await runGuardianReminderSweep();

    expect(count).toBe(2);
  });
});
