/**
 * Rehydration coverage for in-app guardian decision cards (LUM-2919).
 *
 * Selecting Trust / Leave unverified / Block on a message-reaction card resolves
 * the request server-side and the acting client completes its own card
 * optimistically. That optimistic completion is in-memory only, so the terminal
 * state must also reach the conversation's persisted `ui_surface` block, or
 * re-entering the conversation rebuilds history from a card that still looks
 * undecided and re-renders the raw button group.
 *
 * This exercises the real withdrawal → `markSurfaceCompleted` → history-render
 * chain, asserting on what a returning client actually reads back.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";

const broadcasts: AssistantEvent[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: AssistantEvent) => {
    broadcasts.push(msg);
  },
}));

// Stand in for the messages table: `markSurfaceCompleted` scans it for the
// block carrying the surface id and writes the patched content back.
let rows: Array<{
  id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
}> = [];

const realCrud = await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) =>
    rows.filter((r) => r.conversationId === conversationId),
  updateMessageContent: (id: string, content: string) => {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.content = JSON.parse(content);
    }
  },
}));

import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

const { withdrawGuardianRequestCards } =
  await import("../approvals/guardian-card-withdrawal.js");
const { renderHistoryContent } = await import("../daemon/handlers/shared.js");

import type { SimGuardianRequest } from "./guardian-gateway-sim.js";

const CONVERSATION_ID = "conv-rehydration-1";

/** The three-button trust decision card as it is first persisted. */
function seedUndecidedCard(requestId: string): void {
  rows = [
    {
      id: "msg-card",
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: [
        {
          type: "ui_surface",
          surfaceId: `access-request-${requestId}`,
          surfaceType: "card",
          title: "Access Request",
          data: {
            title: "Alice",
            subtitle: "Requesting access to the assistant",
            body: "",
          },
          actions: [
            { id: `apr:${requestId}:trust`, label: "Trust", style: "primary" },
            {
              id: `apr:${requestId}:leave_unverified`,
              label: "Leave unverified",
            },
            {
              id: `apr:${requestId}:block`,
              label: "Block",
              style: "destructive",
            },
          ],
        },
      ],
      createdAt: 0,
      metadata: null,
    },
  ];
}

/** The surface a returning client reads off the rehydrated history row. */
function rehydratedSurface() {
  const row = rows.find((r) => r.id === "msg-card")!;
  return renderHistoryContent(row.content).surfaces[0];
}

/** A pending access request whose in-app card sits in the conversation. */
function seedPendingRequest(): SimGuardianRequest {
  const request = bridgeState.seedRequest({
    kind: "access_request",
    sourceType: "channel",
    sourceChannel: "slack",
    guardianPrincipalId: "rehydration-test-principal",
  });
  bridgeState.seedDelivery({
    requestId: request.id,
    destinationChannel: "vellum",
    destinationConversationId: CONVERSATION_ID,
  });
  seedUndecidedCard(request.id);
  return request;
}

describe("in-app trust decision rehydration", () => {
  beforeEach(() => {
    bridgeState.reset();
    broadcasts.length = 0;
  });

  test("an undecided card still carries its action buttons", () => {
    seedPendingRequest();

    const surface = rehydratedSurface();
    expect(surface?.completed).toBeUndefined();
    expect(surface?.actions).toHaveLength(3);
  });

  test("a decision made in-app rehydrates as completed, not as the button group", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "denied",
      originChannel: "vellum",
      decidedAction: "leave_unverified",
    });

    const surface = rehydratedSurface();
    expect(surface?.completed).toBe(true);
    // The neutral park label, not "Denied": the client infers the completion
    // tone from this string.
    expect(surface?.completionSummary).toBe("Left unverified");
    // The card keeps its content for the audit trail; only the live
    // affordances stop rendering, which the client drives off `completed`.
    expect(surface?.data).toMatchObject({ title: "Alice" });
  });

  test("a trust decision made in-app rehydrates as approved", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "approved",
      originChannel: "vellum",
      decidedAction: "trust",
    });

    const surface = rehydratedSurface();
    expect(surface?.completed).toBe(true);
    expect(surface?.completionSummary).toBe("Approved");
  });

  test("an in-app decision does not re-broadcast over the acting client's own summary", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "approved",
      originChannel: "vellum",
      decidedAction: "trust",
    });

    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(0);
  });

  test("a decision made on another surface both persists and broadcasts", async () => {
    const request = seedPendingRequest();

    await withdrawGuardianRequestCards({
      request,
      status: "denied",
      originChannel: "slack",
      decidedAction: "block",
    });

    expect(rehydratedSurface()?.completionSummary).toBe("Denied");
    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);
  });
});
