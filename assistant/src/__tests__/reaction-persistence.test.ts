/**
 * Tests for Slack reaction event persistence.
 *
 * When the gateway forwards a Slack `reaction_added` or `reaction_removed`
 * event (encoded with `callbackData` prefix `reaction:` or
 * `reaction_removed:`), the daemon must persist it as a `messages` row
 * with `slackMeta.eventKind === "reaction"` so the chronological renderer
 * can surface it inline. Reactions must NOT dispatch to the agent loop —
 * they don't trigger a response.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  listCredentialMetadata: () => [],
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

import { eq } from "drizzle-orm";

import {
  createGuardianBinding,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import type { Conversation } from "../daemon/conversation.js";
import { getDb, initializeDb } from "../memory/db.js";
import {
  createApprovalRequest,
  getPendingApprovalForRequest,
} from "../memory/guardian-approvals.js";
import { messages } from "../memory/schema/conversations.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";
import {
  isSlackReactionEvent,
  parseSlackReactionCallbackData,
} from "../runtime/routes/inbound-message-handler.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";
const SLACK_CHANNEL_ID = "C0REACTION";
const SLACK_USER_ID = "U_REACTOR";
const SLACK_DISPLAY_NAME = "Bob Reactor";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function seedActiveMember(): void {
  upsertContactChannel({
    sourceChannel: "slack",
    externalUserId: SLACK_USER_ID,
    externalChatId: SLACK_CHANNEL_ID,
    status: "active",
    policy: "allow",
    displayName: SLACK_DISPLAY_NAME,
  });
}

let msgCounter = 0;

function buildReactionRequest(
  callbackData: string,
  overrides: Record<string, unknown> = {},
): Request {
  msgCounter++;
  const reactedTs = "1700000000.111111";
  const body: Record<string, unknown> = {
    sourceChannel: "slack",
    interface: "slack",
    conversationExternalId: SLACK_CHANNEL_ID,
    externalMessageId: `${SLACK_CHANNEL_ID}:${reactedTs}:${msgCounter}`,
    content: callbackData,
    callbackData,
    actorExternalId: SLACK_USER_ID,
    actorDisplayName: SLACK_DISPLAY_NAME,
    actorUsername: "bob_reactor",
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: {
      messageId: reactedTs,
      threadId: reactedTs,
      chatType: "channel",
    },
    ...overrides,
  };

  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function readPersistedMessages(): Array<{
  role: string;
  content: string;
  metadata: string | null;
}> {
  const db = getDb();
  return db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .all();
}

// ---------------------------------------------------------------------------
// Helper unit tests
// ---------------------------------------------------------------------------

describe("isSlackReactionEvent", () => {
  test("returns true for reaction added", () => {
    expect(
      isSlackReactionEvent({
        sourceChannel: "slack",
        callbackData: "reaction:thumbsup",
      }),
    ).toBe(true);
  });

  test("returns true for reaction removed", () => {
    expect(
      isSlackReactionEvent({
        sourceChannel: "slack",
        callbackData: "reaction_removed:eyes",
      }),
    ).toBe(true);
  });

  test("returns false for non-Slack source", () => {
    expect(
      isSlackReactionEvent({
        sourceChannel: "telegram",
        callbackData: "reaction:thumbsup",
      }),
    ).toBe(false);
  });

  test("returns false for non-reaction callback data", () => {
    expect(
      isSlackReactionEvent({
        sourceChannel: "slack",
        callbackData: "apr:req-1:approve_once",
      }),
    ).toBe(false);
  });

  test("returns false when callbackData missing", () => {
    expect(isSlackReactionEvent({ sourceChannel: "slack" })).toBe(false);
  });
});

describe("parseSlackReactionCallbackData", () => {
  test("parses reaction:<emoji> as added", () => {
    expect(parseSlackReactionCallbackData("reaction:thumbsup")).toEqual({
      op: "added",
      emoji: "thumbsup",
    });
  });

  test("parses reaction_removed:<emoji> as removed", () => {
    expect(parseSlackReactionCallbackData("reaction_removed:eyes")).toEqual({
      op: "removed",
      emoji: "eyes",
    });
  });

  test("returns null for empty emoji portion", () => {
    expect(parseSlackReactionCallbackData("reaction:")).toBeNull();
    expect(parseSlackReactionCallbackData("reaction_removed:")).toBeNull();
  });

  test("returns null for unrelated callback data", () => {
    expect(parseSlackReactionCallbackData("apr:req-1:approve")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end persistence tests
// ---------------------------------------------------------------------------

describe("Slack reaction event persistence", () => {
  beforeEach(() => {
    resetState();
    seedActiveMember();
    msgCounter = 0;
  });

  test("reaction:thumbsup is persisted with slackMeta.eventKind=reaction", async () => {
    let agentDispatched = false;
    const processMessage = async (): Promise<{ messageId: string }> => {
      agentDispatched = true;
      return { messageId: "should-not-be-called" };
    };

    const req = buildReactionRequest("reaction:thumbsup");
    const resp = await handleChannelInbound(
      req,
      processMessage,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.duplicate).toBe(false);

    expect(agentDispatched).toBe(false);

    const rows = readPersistedMessages();
    expect(rows.length).toBe(1);

    const row = rows[0];
    expect(row.role).toBe("user");
    expect(row.content).toBe("[reaction]");

    const envelope = JSON.parse(row.metadata!) as Record<string, unknown>;
    const slackMetaRaw = envelope.slackMeta;
    expect(typeof slackMetaRaw).toBe("string");

    const slackMeta = readSlackMetadata(slackMetaRaw as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.source).toBe("slack");
    expect(slackMeta!.eventKind).toBe("reaction");
    expect(slackMeta!.channelId).toBe(SLACK_CHANNEL_ID);
    expect(slackMeta!.channelTs).toBe("1700000000.111111");
    expect(slackMeta!.threadTs).toBe("1700000000.111111");
    expect(slackMeta!.displayName).toBe(SLACK_DISPLAY_NAME);
    expect(slackMeta!.reaction).toEqual({
      emoji: "thumbsup",
      actorDisplayName: SLACK_DISPLAY_NAME,
      targetChannelTs: "1700000000.111111",
      op: "added",
    });
  });

  test("reaction_removed:eyes records op === removed", async () => {
    const req = buildReactionRequest("reaction_removed:eyes");
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(200);

    const rows = readPersistedMessages();
    expect(rows.length).toBe(1);

    const envelope = JSON.parse(rows[0].metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(envelope.slackMeta as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.eventKind).toBe("reaction");
    expect(slackMeta!.reaction?.op).toBe("removed");
    expect(slackMeta!.reaction?.emoji).toBe("eyes");
  });

  test("reaction without sourceMetadata.messageId is not persisted", async () => {
    const req = buildReactionRequest("reaction:thumbsup", {
      sourceMetadata: { chatType: "channel" },
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(200);

    const rows = readPersistedMessages();
    expect(rows.length).toBe(0);
  });

  test("reaction without threadId omits threadTs in metadata", async () => {
    const req = buildReactionRequest("reaction:wave", {
      sourceMetadata: {
        messageId: "1700000000.222222",
        chatType: "channel",
      },
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(200);

    const rows = readPersistedMessages();
    expect(rows.length).toBe(1);

    const envelope = JSON.parse(rows[0].metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(envelope.slackMeta as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.threadTs).toBeUndefined();
    expect(slackMeta!.channelTs).toBe("1700000000.222222");
    expect(slackMeta!.reaction?.targetChannelTs).toBe("1700000000.222222");
  });

  test("agent loop is never dispatched for reaction events", async () => {
    let dispatchCount = 0;
    const processMessage = async (): Promise<{ messageId: string }> => {
      dispatchCount++;
      return { messageId: "agent-msg" };
    };

    await handleChannelInbound(
      buildReactionRequest("reaction:thumbsup"),
      processMessage,
      TEST_BEARER_TOKEN,
    );
    await handleChannelInbound(
      buildReactionRequest("reaction_removed:thumbsup"),
      processMessage,
      TEST_BEARER_TOKEN,
    );

    expect(dispatchCount).toBe(0);
  });

  test("duplicate reaction events do not double-persist", async () => {
    const sharedExternalMessageId = `${SLACK_CHANNEL_ID}:1700000000.555555:alice`;
    const makeReq = () =>
      buildReactionRequest("reaction:tada", {
        externalMessageId: sharedExternalMessageId,
      });

    const r1 = await handleChannelInbound(
      makeReq(),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const j1 = (await r1.json()) as Record<string, unknown>;
    expect(j1.duplicate).toBe(false);

    const r2 = await handleChannelInbound(
      makeReq(),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const j2 = (await r2.json()) as Record<string, unknown>;
    expect(j2.duplicate).toBe(true);

    const rows = readPersistedMessages();
    expect(rows.length).toBe(1);
  });

  test("link to channel_inbound_events is created", async () => {
    const req = buildReactionRequest("reaction:thumbsup");
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    const eventId = json.eventId as string;

    const db = getDb();
    const messageRows = db.select().from(messages).all();
    expect(messageRows.length).toBe(1);

    const { channelInboundEvents } = await import("../memory/schema.js");
    const eventRow = db
      .select({ messageId: channelInboundEvents.messageId })
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, eventId))
      .get();
    expect(eventRow?.messageId).toBe(messageRows[0].id);
  });
});

// ---------------------------------------------------------------------------
// Guardian approval-by-reaction integration test
// ---------------------------------------------------------------------------
//
// Verifies that approval interception runs before reaction persistence so a
// guardian's `reaction:` event on a pending approval prompt applies the
// decision and no transcript-line row is written for the reaction itself.

const GUARDIAN_USER_ID = "U_GUARDIAN_REACT";
const GUARDIAN_DISPLAY_NAME = "Guardian Reactor";
const GUARDIAN_REACTION_TOOL = "execute_shell";
const GUARDIAN_REACTION_INPUT = { command: "rm -rf /tmp/test" };

function seedGuardianForChannel(): void {
  createGuardianBinding({
    channel: "slack",
    guardianExternalUserId: GUARDIAN_USER_ID,
    guardianDeliveryChatId: SLACK_CHANNEL_ID,
    guardianPrincipalId: GUARDIAN_USER_ID,
  });
}

function seedPendingGuardianApprovalForReaction(
  requestId: string,
  conversationId: string,
): void {
  createApprovalRequest({
    runId: `run-${requestId}`,
    requestId,
    conversationId,
    channel: "slack",
    requesterExternalUserId: "requester-user-1",
    requesterChatId: SLACK_CHANNEL_ID,
    guardianExternalUserId: GUARDIAN_USER_ID,
    guardianChatId: SLACK_CHANNEL_ID,
    toolName: GUARDIAN_REACTION_TOOL,
    expiresAt: Date.now() + 300_000,
  });

  // Register a pending interaction so applyGuardianDecision finds the
  // requester-side hook to drive `allow`.
  const handleConfirmationResponse = mock(() => {});
  const mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  pendingInteractions.register(requestId, {
    conversation: mockSession,
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName: GUARDIAN_REACTION_TOOL,
      input: GUARDIAN_REACTION_INPUT,
      riskLevel: "high",
      allowlistOptions: [
        { label: "test", description: "test", pattern: "test" },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });
}

describe("guardian approval-by-reaction integration via handleChannelInbound", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM channel_inbound_events");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    db.run("DELETE FROM channel_guardian_approval_requests");
    pendingInteractions.clear();
    msgCounter = 0;
  });

  test("guardian reaction on pending approval applies decision and persists no transcript row", async () => {
    seedGuardianForChannel();
    const requestId = "req-guardian-react-1";
    // Conversation must exist so the approval row's conversation_id FK
    // resolves; reuse an inbound seed by sending a no-op message that the
    // ACL allows. Easier: insert directly via the DB layer.
    const db = getDb();
    const conversationId = "conv-react-test-1";
    const now = Date.now();
    db.$client
      .prepare(
        `INSERT INTO conversations (
          id, title, created_at, updated_at, total_input_tokens, total_output_tokens,
          total_estimated_cost, context_compacted_message_count, conversation_type,
          source, memory_scope_id, host_access, is_auto_title
        ) VALUES (?, NULL, ?, ?, 0, 0, 0, 0, 'standard', 'user', 'default', 0, 1)`,
      )
      .run(conversationId, now, now);

    seedPendingGuardianApprovalForReaction(requestId, conversationId);

    const reactedTs = "1700000099.000001";
    const body = {
      sourceChannel: "slack",
      interface: "slack",
      conversationExternalId: SLACK_CHANNEL_ID,
      externalMessageId: `${SLACK_CHANNEL_ID}:${reactedTs}:guardian-react`,
      content: "reaction:white_check_mark",
      callbackData: "reaction:white_check_mark",
      actorExternalId: GUARDIAN_USER_ID,
      actorDisplayName: GUARDIAN_DISPLAY_NAME,
      replyCallbackUrl: "http://localhost:7830/deliver/slack",
      sourceMetadata: {
        messageId: reactedTs,
        chatType: "channel",
      },
    };
    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify(body),
    });

    // Wire a non-undefined `approvalConversationGenerator` to mirror the
    // production configuration. The deterministic reaction handler must
    // short-circuit before the generator is consulted — if it runs, it
    // returns `keep_pending` so the assertions below would fail loudly.
    const approvalConversationGenerator = mock(async () => ({
      disposition: "keep_pending" as const,
      replyText: "mock conversational turn should not be invoked for reactions",
    }));

    const resp = await handleChannelInbound(
      req,
      undefined,
      TEST_BEARER_TOKEN,
      undefined,
      approvalConversationGenerator,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.approval).toBe("guardian_decision_applied");
    expect(approvalConversationGenerator).not.toHaveBeenCalled();

    // The pending approval row is resolved (no longer pending).
    expect(getPendingApprovalForRequest(requestId)).toBeNull();

    // No transcript row was written for the reaction itself — resolved
    // guardian approval reactions have no transcript representation.
    const reactionRows = readPersistedMessages().filter((row) => {
      if (!row.metadata) return false;
      try {
        const env = JSON.parse(row.metadata) as Record<string, unknown>;
        if (typeof env.slackMeta !== "string") return false;
        const meta = readSlackMetadata(env.slackMeta);
        return meta?.eventKind === "reaction";
      } catch {
        return false;
      }
    });
    expect(reactionRows.length).toBe(0);
  });
});
