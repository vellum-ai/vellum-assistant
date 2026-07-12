/**
 * Tests for guardian request expiry side effects:
 *
 * 1. notifyExpiredGuardianRequest — per-kind behavior (requester notice for
 *    access_request / tool_grant_request, interaction release for tool_approval,
 *    no-op for pending_question), Slack DM routing, non-deliverable channels,
 *    and best-effort (non-throwing) delivery.
 * 2. Sweep integration — an expired request is transitioned to `expired` and the
 *    requester is notified through the wired-in notifier.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence logging.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// Capture requester channel deliveries; optionally fail to exercise the
// best-effort path.
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
    if (deliveryError) throw deliveryError;
    deliveredReplies.push({ url, payload });
  },
}));

// Capture hub broadcasts (interaction_resolved) emitted by pendingInteractions.
const broadcasts: Array<Record<string, unknown>> = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcasts.push(msg);
  },
}));

// The sweep withdraws cards via this module; we only assert it is invoked, and
// mocking it keeps the sweep import light (no surface/slack transitive deps).
let withdrawCalls = 0;
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: async () => {
    withdrawCalls++;
  },
}));

// Gateway guardian-request client — in-memory rows driven by tests. The sweep
// asks the gateway to CAS-expire past-deadline pending rows and fans out
// notifications from the returned rows.
const gatewayRequests = new Map<string, GuardianRequestWire>();
mock.module("../channels/gateway-guardian-requests.js", () => ({
  sweepExpiredGuardianRequests: async () => {
    const now = Date.now();
    const expired: GuardianRequestWire[] = [];
    for (const row of gatewayRequests.values()) {
      if (
        row.status === "pending" &&
        row.expiresAt !== null &&
        row.expiresAt <= now
      ) {
        const flipped = { ...row, status: "expired" as const };
        gatewayRequests.set(row.id, flipped);
        expired.push(flipped);
      }
    }
    return expired;
  },
}));

import { notifyExpiredGuardianRequest } from "../approvals/guardian-expiry-notifier.js";
import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { runGuardianExpirySweep } from "../runtime/routes/guardian-expiry-sweep.js";

/** Build a fully-populated wire request, overriding the interesting bits. */
function makeRequest(
  overrides: Partial<GuardianRequestWire> & { kind: string },
): GuardianRequestWire {
  return {
    id: "req-1",
    sourceType: "channel",
    sourceChannel: "telegram",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "req-user",
    requesterChatId: "req-chat",
    requestTrigger: null,
    guardianExternalUserId: "guardian-user",
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
    status: "expired",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: null,
    expiresAt: 1000,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

beforeEach(() => {
  deliveredReplies.length = 0;
  broadcasts.length = 0;
  deliveryError = null;
  withdrawCalls = 0;
  pendingInteractions.clear();
});

describe("notifyExpiredGuardianRequest", () => {
  test("access_request: notifies the requester on their channel", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({
        kind: "access_request",
        sourceChannel: "telegram",
        requesterChatId: "tg-chat",
        requesterExternalUserId: "tg-user",
      }),
    );

    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].url).toBe("/deliver/telegram");
    expect(deliveredReplies[0].payload.chatId).toBe("tg-chat");
    expect(deliveredReplies[0].payload.text).toContain(
      "access request expired",
    );
  });

  test("access_request on Slack: routes to the requester DM, not the channel", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({
        kind: "access_request",
        sourceChannel: "slack",
        requesterChatId: "C0SHARED",
        requesterExternalUserId: "U123",
      }),
    );

    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].url).toBe("/deliver/slack");
    // DM via the user id, never the shared channel id.
    expect(deliveredReplies[0].payload.chatId).toBe("U123");
  });

  test("tool_grant_request: notice names the tool", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({
        kind: "tool_grant_request",
        sourceChannel: "telegram",
        requesterChatId: "tg-chat",
        toolName: "bash",
      }),
    );

    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].payload.text).toContain('"bash"');
    expect(deliveredReplies[0].payload.text).toContain("expired");
  });

  test("tool_approval: releases the pending interaction, sends no channel notice", async () => {
    pendingInteractions.register("req-ta", {
      conversationId: "conv-1",
      kind: "confirmation",
    });

    await notifyExpiredGuardianRequest(
      makeRequest({ id: "req-ta", kind: "tool_approval" }),
    );

    expect(pendingInteractions.get("req-ta")).toBeUndefined();
    const resolvedEvent = broadcasts.find(
      (b) => b.type === "interaction_resolved",
    );
    expect(resolvedEvent).toMatchObject({
      requestId: "req-ta",
      state: "cancelled",
    });
    expect(deliveredReplies).toHaveLength(0);
  });

  test("tool_approval: no registered interaction is a safe no-op", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({ id: "req-none", kind: "tool_approval" }),
    );

    expect(deliveredReplies).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  test("pending_question: no notice (voice owns its lifecycle)", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({ kind: "pending_question", sourceChannel: "phone" }),
    );

    expect(deliveredReplies).toHaveLength(0);
  });

  test("non-deliverable channel: no notice", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({ kind: "access_request", sourceChannel: "vellum" }),
    );

    expect(deliveredReplies).toHaveLength(0);
  });

  test("missing requester chat: no notice", async () => {
    await notifyExpiredGuardianRequest(
      makeRequest({
        kind: "access_request",
        sourceChannel: "telegram",
        requesterChatId: null,
        requesterExternalUserId: null,
      }),
    );

    expect(deliveredReplies).toHaveLength(0);
  });

  test("delivery failure is swallowed (best-effort)", async () => {
    deliveryError = new Error("gateway down");

    await expect(
      notifyExpiredGuardianRequest(
        makeRequest({
          kind: "access_request",
          sourceChannel: "telegram",
          requesterChatId: "tg-chat",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("sweep integration", () => {
  beforeEach(() => {
    gatewayRequests.clear();
  });

  test("expired access_request is transitioned and the requester is notified", async () => {
    gatewayRequests.set(
      "req-sweep",
      makeRequest({
        id: "req-sweep",
        kind: "access_request",
        status: "pending",
        requesterChatId: "tg-chat",
        requesterExternalUserId: "tg-user",
        expiresAt: Date.now() - 1000, // already past
      }),
    );

    const expiredCount = await runGuardianExpirySweep();

    expect(expiredCount).toBe(1);
    expect(gatewayRequests.get("req-sweep")?.status).toBe("expired");
    expect(withdrawCalls).toBe(1);
    expect(deliveredReplies).toHaveLength(1);
    expect(deliveredReplies[0].payload.text).toContain(
      "access request expired",
    );
  });

  test("not-yet-expired requests are left pending and unnotified", async () => {
    gatewayRequests.set(
      "req-fresh",
      makeRequest({
        id: "req-fresh",
        kind: "access_request",
        status: "pending",
        requesterChatId: "tg-chat",
        expiresAt: Date.now() + 60_000, // still in the future
      }),
    );

    const expiredCount = await runGuardianExpirySweep();

    expect(expiredCount).toBe(0);
    expect(gatewayRequests.get("req-fresh")?.status).toBe("pending");
    expect(deliveredReplies).toHaveLength(0);
  });
});
