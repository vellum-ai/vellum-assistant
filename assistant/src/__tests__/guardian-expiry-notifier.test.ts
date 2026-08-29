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
    if (deliveryError) {
      throw deliveryError;
    }
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

// The sweep withdraws cards via this module; mocking it keeps the sweep
// import light (no surface/slack transitive deps). The completeness result
// gates the sweep's expire confirmation.
let withdrawCalls = 0;
let withdrawIncomplete = false;
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: async () => {
    withdrawCalls++;
    return { complete: !withdrawIncomplete };
  },
}));

// Gateway guardian-request client, in-memory rows driven by tests. The
// sweep lists past-deadline pending rows read-only and confirms each with
// the per-request expire CAS after its side effects run.
const gatewayRequests = new Map<string, GuardianRequestWire>();
let expireCasFails = false;
const actualGatewayGuardianRequests =
  await import("../channels/gateway-guardian-requests.js");
mock.module("../channels/gateway-guardian-requests.js", () => ({
  ...actualGatewayGuardianRequests,
  listExpiredPendingGuardianRequests: async () => {
    const now = Date.now();
    const stale: GuardianRequestWire[] = [];
    for (const row of gatewayRequests.values()) {
      if (
        row.status === "pending" &&
        row.expiresAt !== null &&
        row.expiresAt <= now
      ) {
        stale.push(row);
      }
    }
    return stale;
  },
  expireGuardianRequest: async (id: string) => {
    if (expireCasFails) {
      throw new Error("simulated IPC timeout");
    }
    const row = gatewayRequests.get(id);
    if (row?.status === "pending") {
      gatewayRequests.set(id, { ...row, status: "expired" as const });
    }
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
  withdrawIncomplete = false;
  expireCasFails = false;
  gatewayRequests.clear();
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

  test("delivery failure never throws, and reports incomplete", async () => {
    deliveryError = new Error("gateway down");

    await expect(
      notifyExpiredGuardianRequest(
        makeRequest({
          kind: "access_request",
          sourceChannel: "telegram",
          requesterChatId: "tg-chat",
        }),
      ),
    ).resolves.toEqual({ complete: false });
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

  test("an incomplete withdrawal defers the request and holds the notice back", async () => {
    // A card edit that failed leaves an actionable control somewhere, so the
    // request must stay pending and retryable. The notice is held back too:
    // sending it only after withdrawal completes means the retry round can
    // never duplicate a delivered notice.
    gatewayRequests.set(
      "req-withdraw-fail",
      makeRequest({
        id: "req-withdraw-fail",
        kind: "access_request",
        status: "pending",
        requesterChatId: "tg-chat",
        requesterExternalUserId: "tg-user",
        expiresAt: Date.now() - 1000,
      }),
    );

    withdrawIncomplete = true;
    expect(await runGuardianExpirySweep()).toBe(0);
    expect(gatewayRequests.get("req-withdraw-fail")?.status).toBe("pending");
    expect(deliveredReplies).toHaveLength(0);

    withdrawIncomplete = false;
    expect(await runGuardianExpirySweep()).toBe(1);
    expect(gatewayRequests.get("req-withdraw-fail")?.status).toBe("expired");
    expect(deliveredReplies).toHaveLength(1);
  });

  test("a failed requester notice defers the request until a retry delivers it", async () => {
    gatewayRequests.set(
      "req-notice-fail",
      makeRequest({
        id: "req-notice-fail",
        kind: "access_request",
        status: "pending",
        requesterChatId: "tg-chat",
        requesterExternalUserId: "tg-user",
        expiresAt: Date.now() - 1000,
      }),
    );

    deliveryError = new Error("channel briefly unreachable");
    expect(await runGuardianExpirySweep()).toBe(0);
    expect(gatewayRequests.get("req-notice-fail")?.status).toBe("pending");
    expect(deliveredReplies).toHaveLength(0);

    deliveryError = null;
    expect(await runGuardianExpirySweep()).toBe(1);
    expect(gatewayRequests.get("req-notice-fail")?.status).toBe("expired");
    // The notice lands exactly once: the failed attempt delivered nothing.
    expect(deliveredReplies).toHaveLength(1);
  });

  test("a lost expire confirmation leaves the row pending, and the next round recovers it", async () => {
    // The status flip is the receipt that side effects ran, not the
    // announcement that they should. When the confirmation is lost, the row
    // must stay in the pending set so the next round re-runs its fan-out;
    // the cost is at-least-once side effects, never their silent loss.
    gatewayRequests.set(
      "req-lost",
      makeRequest({
        id: "req-lost",
        kind: "access_request",
        status: "pending",
        requesterChatId: "tg-chat",
        requesterExternalUserId: "tg-user",
        expiresAt: Date.now() - 1000,
      }),
    );

    expireCasFails = true;
    expect(await runGuardianExpirySweep()).toBe(0);
    expect(gatewayRequests.get("req-lost")?.status).toBe("pending");
    expect(withdrawCalls).toBe(1);
    expect(deliveredReplies).toHaveLength(1);

    expireCasFails = false;
    expect(await runGuardianExpirySweep()).toBe(1);
    expect(gatewayRequests.get("req-lost")?.status).toBe("expired");
    // The re-run repeats the side effects (at-least-once); the third round
    // finds nothing.
    expect(withdrawCalls).toBe(2);
    expect(deliveredReplies).toHaveLength(2);
    expect(await runGuardianExpirySweep()).toBe(0);
    expect(withdrawCalls).toBe(2);
  });
});
