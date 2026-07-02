/**
 * Tests for guardian approval-by-reaction on the canonical pipeline.
 *
 * A Slack emoji reaction (✅ / ❌) on a delivered approval card is routed
 * through `routeGuardianReply` exactly like a button press or text reply. The
 * emoji maps to an action and the reacted card's message id (`reactedMessageTs`)
 * resolves the target request via its canonical delivery record — so the
 * decision is applied precisely even when several cards are pending in the same
 * chat, with no clarification prompt.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
}));

import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  getPendingCanonicalRequestByDestinationMessage,
  resolveCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import type { Conversation } from "../daemon/conversation.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  inferDecisionActionFromFreeText,
  routeGuardianReply,
} from "../runtime/guardian-reply-router.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const GUARDIAN_USER = "U_GUARDIAN";
const PRINCIPAL = "principal-1";
const CHAT_ID = "D_GUARDIAN_DM";
const TOOL_NAME = "execute_shell";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM scoped_approval_grants");
  pendingInteractions.clear();
  _conversationMocks.clear();
}

/**
 * Seed a pending tool-approval (canonical request + delivery + pending
 * interaction with a mock conversation) and return the mocked
 * `handleConfirmationResponse` so callers can assert it was driven.
 */
function seedApproval(opts: {
  requestId: string;
  ts: string;
  chatId?: string;
  principal?: string;
}): ReturnType<typeof mock> {
  const chatId = opts.chatId ?? CHAT_ID;
  const principal = opts.principal ?? PRINCIPAL;
  const conversationId = `conv-${opts.requestId}`;

  createCanonicalGuardianRequest({
    id: opts.requestId,
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "slack",
    conversationId,
    requesterExternalUserId: "requester-1",
    requesterChatId: chatId,
    guardianExternalUserId: GUARDIAN_USER,
    guardianPrincipalId: principal,
    toolName: TOOL_NAME,
    status: "pending",
    expiresAt: Date.now() + 300_000,
  });

  createCanonicalGuardianDelivery({
    requestId: opts.requestId,
    destinationChannel: "slack",
    destinationChatId: chatId,
    destinationMessageId: opts.ts,
  });

  const handleConfirmationResponse = mock(() => {});
  _conversationMocks.set(conversationId, {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation);
  pendingInteractions.register(opts.requestId, {
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName: TOOL_NAME,
      input: { command: "echo hi" },
      riskLevel: "high",
      allowlistOptions: [{ label: "t", description: "t", pattern: "t" }],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });
  return handleConfirmationResponse;
}

function reaction(opts: {
  emoji: string;
  reactedMessageTs?: string;
  chatId?: string;
  principal?: string;
}): Parameters<typeof routeGuardianReply>[0] {
  return {
    messageText: "",
    channel: "slack",
    actor: {
      actorPrincipalId: opts.principal ?? PRINCIPAL,
      actorExternalUserId: GUARDIAN_USER,
      channel: "slack",
      guardianPrincipalId: opts.principal ?? PRINCIPAL,
    },
    conversationId: "guardian-conv",
    callbackData: `reaction:${opts.emoji}`,
    reactedMessageTs: opts.reactedMessageTs,
    channelDeliveryContext: {
      replyCallbackUrl: "https://gateway.test/deliver",
      guardianChatId: opts.chatId ?? CHAT_ID,
      assistantId: "self",
    },
  };
}

// ---------------------------------------------------------------------------
// Store lookup
// ---------------------------------------------------------------------------

describe("getPendingCanonicalRequestByDestinationMessage", () => {
  beforeEach(resetTables);

  test("resolves the request whose delivery matches channel + chat + message id", () => {
    seedApproval({ requestId: "req-1", ts: "1700000000.000001" });
    const found = getPendingCanonicalRequestByDestinationMessage(
      "slack",
      CHAT_ID,
      "1700000000.000001",
    );
    expect(found?.id).toBe("req-1");
  });

  test("returns null when no delivery matches the message id", () => {
    seedApproval({ requestId: "req-1", ts: "1700000000.000001" });
    expect(
      getPendingCanonicalRequestByDestinationMessage(
        "slack",
        CHAT_ID,
        "9999.0",
      ),
    ).toBeNull();
  });

  test("returns null once the matched request is no longer pending", () => {
    seedApproval({ requestId: "req-1", ts: "1700000000.000001" });
    resolveCanonicalGuardianRequest("req-1", "pending", { status: "approved" });
    expect(
      getPendingCanonicalRequestByDestinationMessage(
        "slack",
        CHAT_ID,
        "1700000000.000001",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reaction routing
// ---------------------------------------------------------------------------

describe("routeGuardianReply / reactions", () => {
  beforeEach(resetTables);

  test("✅ on a delivered card approves the matching request", async () => {
    const hcr = seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({ emoji: "white_check_mark", reactedMessageTs: "111.1" }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);
    expect(result.type).toBe("canonical_decision_applied");
    expect(getCanonicalGuardianRequest("req-1")?.status).toBe("approved");
    expect(hcr).toHaveBeenCalledTimes(1);
    expect(hcr.mock.calls[0]?.[0]).toBe("req-1");
    expect(hcr.mock.calls[0]?.[1]).toBe("allow");
  });

  test("❌ on a delivered card rejects the matching request", async () => {
    const hcr = seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({ emoji: "-1", reactedMessageTs: "111.1" }),
    );

    expect(result.decisionApplied).toBe(true);
    expect(getCanonicalGuardianRequest("req-1")?.status).toBe("denied");
    expect(hcr.mock.calls[0]?.[1]).toBe("deny");
  });

  test("reacting on a specific card resolves only that card (disambiguates N>1)", async () => {
    const hcrA = seedApproval({ requestId: "req-A", ts: "100.1" });
    const hcrB = seedApproval({ requestId: "req-B", ts: "200.2" });

    // React on card B's message — only B should resolve.
    const result = await routeGuardianReply(
      reaction({ emoji: "white_check_mark", reactedMessageTs: "200.2" }),
    );

    expect(result.requestId).toBe("req-B");
    expect(getCanonicalGuardianRequest("req-B")?.status).toBe("approved");
    expect(getCanonicalGuardianRequest("req-A")?.status).toBe("pending");
    expect(hcrB).toHaveBeenCalledTimes(1);
    expect(hcrA).not.toHaveBeenCalled();
  });

  test("a reaction on an unknown message is not consumed (left for transcript)", async () => {
    seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({ emoji: "white_check_mark", reactedMessageTs: "no-such-ts" }),
    );

    expect(result.consumed).toBe(false);
    expect(result.type).toBe("not_consumed");
    expect(getCanonicalGuardianRequest("req-1")?.status).toBe("pending");
  });

  test("an unknown emoji is not consumed", async () => {
    seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({ emoji: "tada", reactedMessageTs: "111.1" }),
    );

    expect(result.consumed).toBe(false);
    expect(getCanonicalGuardianRequest("req-1")?.status).toBe("pending");
  });

  test("a reaction without a reacted message id is not consumed", async () => {
    seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({ emoji: "white_check_mark" }),
    );

    expect(result.consumed).toBe(false);
  });

  test("a reaction from a different principal is surfaced, not silently dropped", async () => {
    const hcr = seedApproval({ requestId: "req-1", ts: "111.1" });

    const result = await routeGuardianReply(
      reaction({
        emoji: "white_check_mark",
        reactedMessageTs: "111.1",
        principal: "someone-else",
      }),
    );

    // Consumed with a user-facing reply, request untouched, side effect not run.
    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(false);
    expect(result.replyText).toMatch(/permission/i);
    expect(getCanonicalGuardianRequest("req-1")?.status).toBe("pending");
    expect(hcr).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Free-text decision inference (no request code)
// ---------------------------------------------------------------------------

describe("inferDecisionActionFromFreeText / introduction verbs", () => {
  // Regression: a bare "block" on an access request must map to the block
  // action (revoke), not the weaker generic reject (leave_unverified).
  test('"block" maps to block for access requests, reject elsewhere', () => {
    expect(inferDecisionActionFromFreeText("block", "access_request")).toBe(
      "block",
    );
    expect(inferDecisionActionFromFreeText("Block!", "access_request")).toBe(
      "block",
    );
    expect(inferDecisionActionFromFreeText("block")).toBe("reject");
    expect(inferDecisionActionFromFreeText("block", "tool_approval")).toBe(
      "reject",
    );
  });

  test("trust and verify verbs are recognized for access requests", () => {
    expect(inferDecisionActionFromFreeText("trust", "access_request")).toBe(
      "trust",
    );
    expect(inferDecisionActionFromFreeText("verify", "access_request")).toBe(
      "verify_code",
    );
    // Unknown outside access requests — falls through to null (no cue).
    expect(inferDecisionActionFromFreeText("trust")).toBeNull();
  });

  test("generic vocabulary keeps its semantics per kind", () => {
    expect(inferDecisionActionFromFreeText("no", "access_request")).toBe(
      "leave_unverified",
    );
    expect(inferDecisionActionFromFreeText("reject", "access_request")).toBe(
      "leave_unverified",
    );
    expect(inferDecisionActionFromFreeText("yes", "access_request")).toBe(
      "approve_once",
    );
    expect(inferDecisionActionFromFreeText("no", "tool_approval")).toBe(
      "reject",
    );
  });
});
