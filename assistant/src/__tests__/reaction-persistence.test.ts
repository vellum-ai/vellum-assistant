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

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
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

// Guardian identity resolves via the gateway delivery cache, not the local
// contacts DB. Seed it per-test via seedGatewayGuardian so the guardian
// reactor classifies as `trustClass === "guardian"`.
interface GatewayGuardian {
  channelType: string;
  address: string;
  principalId?: string | null;
  externalChatId?: string | null;
  status: string;
}
let gatewayGuardians: GatewayGuardian[] = [];
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => gatewayGuardians,
  peekCachedGuardianDelivery: (input?: { channelTypes?: string[] }) => {
    if (!input?.channelTypes) {
      return gatewayGuardians;
    }
    return gatewayGuardians.filter((g) =>
      input.channelTypes!.includes(g.channelType),
    );
  },
  guardianForChannel: (list: GatewayGuardian[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
  anyGuardian: (list: GatewayGuardian[]) => list[0],
}));

function seedGatewayGuardian(
  g: Partial<GatewayGuardian> & {
    channelType: string;
    address: string;
  },
): void {
  gatewayGuardians.push({ status: "active", ...g });
}

import { eq } from "drizzle-orm";

import type { Conversation } from "../daemon/conversation.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { linkMessage, recordInbound } from "../persistence/delivery-crud.js";
import { messages } from "../persistence/schema/conversations.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import {
  isSlackReactionEvent,
  parseSlackReactionCallbackData,
} from "../runtime/routes/inbound-stages/reaction-intercept.js";
import {
  handleChannelInbound,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { bridgeState } from "./helpers/gateway-guardian-requests-store-bridge.js";

await initializeDb();

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
  gatewayGuardians = [];
}

function seedActiveMember(): void {
  seedContactChannel({
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

/**
 * Store the message a reaction will be attached to. A reaction resolves its
 * conversation through this row, so without one there is nothing to annotate.
 */
function seedStoredMessage(reactedTs: string): string {
  const event = recordInbound(
    "slack",
    SLACK_CHANNEL_ID,
    `${SLACK_CHANNEL_ID}:${reactedTs}:seed`,
    { sourceMessageId: reactedTs },
  );
  const db = getDb();
  const messageId = `msg-${reactedTs}`;
  db.$client
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, 'user', '"hello"', ?)`,
    )
    .run(messageId, event.conversationId, Date.now());
  linkMessage(event.eventId, messageId);
  return event.conversationId;
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
    seedStoredMessage("1700000000.111111");
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

    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
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
    // Slack sends no thread on a reaction, so the row claims none.
    expect(slackMeta!.threadTs).toBeUndefined();
    expect(slackMeta!.displayName).toBe(SLACK_DISPLAY_NAME);
    expect(slackMeta!.reaction).toEqual({
      emoji: "thumbsup",
      actorDisplayName: SLACK_DISPLAY_NAME,
      targetChannelTs: "1700000000.111111",
      op: "added",
    });
  });

  test("reaction_removed:eyes records op === removed", async () => {
    seedStoredMessage("1700000000.111111");
    const req = buildReactionRequest("reaction_removed:eyes");
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(200);

    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
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
    expect(((await resp.json()) as Record<string, unknown>).reaction).toBe(
      "dropped_unknown_target",
    );

    const rows = readPersistedMessages();
    expect(rows.length).toBe(0);
  });

  test("a reaction never claims a thread, so it is not thread evidence", async () => {
    // Storing the gateway's fabricated thread id here made the row look like
    // proof that a thread belongs to this conversation.
    seedStoredMessage("1700000000.111111");
    await handleChannelInbound(
      buildReactionRequest("reaction:thumbsup"),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
    const meta = readSlackMetadata(
      (JSON.parse(rows[0].metadata!) as Record<string, unknown>)
        .slackMeta as string,
    );
    expect(meta?.threadTs).toBeUndefined();
  });

  test("reaction without threadId omits threadTs in metadata", async () => {
    seedStoredMessage("1700000000.222222");
    const req = buildReactionRequest("reaction:wave", {
      sourceMetadata: {
        messageId: "1700000000.222222",
        chatType: "channel",
      },
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(200);

    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
    expect(rows.length).toBe(1);

    const envelope = JSON.parse(rows[0].metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(envelope.slackMeta as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.threadTs).toBeUndefined();
    expect(slackMeta!.channelTs).toBe("1700000000.222222");
    expect(slackMeta!.reaction?.targetChannelTs).toBe("1700000000.222222");
  });

  test("agent loop is never dispatched for reaction events", async () => {
    seedStoredMessage("1700000000.111111");
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
    seedStoredMessage("1700000000.111111");
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

    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
    expect(rows.length).toBe(1);
  });

  test("reaction on the assistant's own post lands in that conversation", async () => {
    // An outbound post opens no inbound event, so the only record of its ts
    // is the `slackMeta` on the assistant row. Seeded here the way the
    // outbound reconciler writes it.
    const botTs = "1700000000.999999";
    const conversationId = seedStoredMessage("1700000000.111111");
    const db = getDb();
    db.$client
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata)
         VALUES (?, ?, 'assistant', '"posted"', ?, ?)`,
      )
      .run(
        "msg-bot-post",
        conversationId,
        Date.now(),
        JSON.stringify({
          slackMeta: JSON.stringify({
            source: "slack",
            channelId: SLACK_CHANNEL_ID,
            channelTs: botTs,
            eventKind: "message",
          }),
        }),
      );

    const resp = await handleChannelInbound(
      buildReactionRequest("reaction:tada", {
        externalMessageId: `${SLACK_CHANNEL_ID}:${botTs}:reactor`,
        sourceMetadata: { messageId: botTs, chatType: "channel" },
      }),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(resp.status).toBe(200);

    const reactionRow = db.$client
      .prepare(
        "SELECT conversation_id AS conversationId FROM messages WHERE content = '[reaction]'",
      )
      .get() as { conversationId: string } | null;
    expect(reactionRow?.conversationId).toBe(conversationId);
  });

  test("a reaction leaves the reacted message resolvable by its own id", async () => {
    // Two linked rows on one provider id would let a later edit or delete of
    // the message resolve to the reaction instead.
    const reactedTs = "1700000000.111111";
    seedStoredMessage(reactedTs);
    await handleChannelInbound(
      buildReactionRequest("reaction:thumbsup"),
      undefined,
      TEST_BEARER_TOKEN,
    );

    const db = getDb();
    const claimants = (
      db.$client
        .prepare(
          `SELECT COUNT(*) AS n FROM channel_inbound_events
           WHERE source_message_id = ? AND message_id IS NOT NULL`,
        )
        .get(reactedTs) as { n: number }
    ).n;
    expect(claimants).toBe(1);
  });

  test("reaction on a message the assistant never stored creates no conversation", async () => {
    // The reported bug: Slack sends no `thread_ts` on a reaction, so keying a
    // conversation off the reaction's own address minted one per reacted
    // message, each holding a single "[reaction]" row and a permanent
    // "Generating title..." placeholder.
    const db = getDb();
    const countRows = (table: string): number =>
      (
        db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;

    const resp = await handleChannelInbound(
      buildReactionRequest("reaction:thumbsup"),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.reaction).toBe("dropped_unknown_target");
    expect(countRows("conversations")).toBe(0);
    expect(countRows("channel_inbound_events")).toBe(0);
    expect(readPersistedMessages().length).toBe(0);
  });

  test("reaction lands in the conversation of the reacted message, not a new one", async () => {
    const targetConversationId = seedStoredMessage("1700000000.111111");
    const db = getDb();
    const conversationsBefore = (
      db.$client.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
        n: number;
      }
    ).n;

    const resp = await handleChannelInbound(
      buildReactionRequest("reaction:thumbsup"),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(resp.status).toBe(200);

    const conversationsAfter = (
      db.$client.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
        n: number;
      }
    ).n;
    expect(conversationsAfter).toBe(conversationsBefore);

    const reactionRow = db.$client
      .prepare(
        "SELECT conversation_id AS conversationId FROM messages WHERE content = '[reaction]'",
      )
      .get() as { conversationId: string } | null;
    expect(reactionRow?.conversationId).toBe(targetConversationId);
  });

  test("link to channel_inbound_events is created", async () => {
    seedStoredMessage("1700000000.111111");
    const req = buildReactionRequest("reaction:thumbsup");
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    const eventId = json.eventId as string;

    const db = getDb();
    const messageRows = db
      .select()
      .from(messages)
      .all()
      .filter((row) => row.content === "[reaction]");
    expect(messageRows.length).toBe(1);

    const { channelInboundEvents } =
      await import("../persistence/schema/index.js");
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
  seedGatewayGuardian({
    channelType: "slack",
    address: GUARDIAN_USER_ID,
    principalId: GUARDIAN_USER_ID,
    externalChatId: SLACK_CHANNEL_ID,
  });
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
  reactedTs: string,
): void {
  // Canonical tool_approval request keyed by the confirmation requestId — the
  // same record assistant-event-hub creates for every confirmation.
  bridgeState.seedRequest({
    id: requestId,
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "slack",
    sourceConversationId: conversationId,
    requesterExternalUserId: "requester-user-1",
    requesterChatId: SLACK_CHANNEL_ID,
    guardianExternalUserId: GUARDIAN_USER_ID,
    guardianPrincipalId: GUARDIAN_USER_ID,
    toolName: GUARDIAN_REACTION_TOOL,
    status: "pending",
    expiresAt: Date.now() + 300_000,
  });

  // The delivered approval card → request mapping the reaction resolves
  // against (destination message id = the reacted Slack ts).
  bridgeState.seedDelivery({
    requestId,
    destinationChannel: "slack",
    destinationChatId: SLACK_CHANNEL_ID,
    destinationMessageId: reactedTs,
  });

  // Register a pending interaction so the tool_approval resolver finds the
  // requester-side hook to drive `allow`.
  const handleConfirmationResponse = mock(() => {});
  const _mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  _conversationMocks.set(conversationId, _mockSession);
  pendingInteractions.register(requestId, {
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
    bridgeState.reset();
    gatewayGuardians = [];
    pendingInteractions.clear();
    msgCounter = 0;
  });

  test("guardian reaction on pending approval applies decision and persists no transcript row", async () => {
    seedGuardianForChannel();
    const requestId = "req-guardian-react-1";
    // Back the guardian request and its pending interaction with a real
    // conversation row, inserted directly via the DB layer.
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

    const reactedTs = "1700000099.000001";
    // The approval card was delivered on this ts; its canonical delivery row
    // is how the guardian reaction is scoped to a known approval message.
    seedPendingGuardianApprovalForReaction(
      requestId,
      conversationId,
      reactedTs,
    );

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
    expect(json.canonicalRouter).toBe("canonical_decision_applied");
    expect(approvalConversationGenerator).not.toHaveBeenCalled();

    // The guardian request is resolved (no longer pending).
    expect(bridgeState.getRequest(requestId)?.status).toBe("approved");

    // No transcript row was written for the reaction itself — resolved
    // guardian approval reactions have no transcript representation.
    const reactionRows = readPersistedMessages().filter((row) => {
      if (!row.metadata) {
        return false;
      }
      try {
        const env = JSON.parse(row.metadata) as Record<string, unknown>;
        if (typeof env.slackMeta !== "string") {
          return false;
        }
        const meta = readSlackMetadata(env.slackMeta);
        return meta?.eventKind === "reaction";
      } catch {
        return false;
      }
    });
    expect(reactionRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reaction access-control regression (LUM-2489)
// ---------------------------------------------------------------------------
//
// A reaction is a passive signal, not an access attempt. Because reactions are
// dispatched before the ingress pipeline, an unknown user's 👍 must never run
// ACL (no trusted-contact verification handshake), create a conversation, or
// write a binding — it is dropped as channel noise. A known contact's reaction
// is recorded; neither triggers a verification challenge.

describe("reaction access control (no verification handshake)", () => {
  const STRANGER_USER_ID = "U_REACTION_STRANGER";
  const CONTACT_USER_ID = "U_REACTION_CONTACT";
  // Guardian's approval channel is a DM, distinct from the public channel the
  // reaction lands in (mirroring production). Reusing the public channel id
  // would let a reactor match the guardian's channel via findContactChannel's
  // externalChatId fallback and mask the bug.
  const GUARDIAN_DM_CHAT = "D_GUARDIAN_DM";

  function tableCount(table: string): number {
    return (
      getDb().$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  }

  beforeEach(() => {
    resetState();
    // The assistant has a guardian (as in production); the reactors below are
    // different users.
    seedGatewayGuardian({
      channelType: "slack",
      address: GUARDIAN_USER_ID,
      principalId: GUARDIAN_USER_ID,
      externalChatId: GUARDIAN_DM_CHAT,
    });
    createGuardianBinding({
      channel: "slack",
      guardianExternalUserId: GUARDIAN_USER_ID,
      guardianDeliveryChatId: GUARDIAN_DM_CHAT,
      guardianPrincipalId: GUARDIAN_USER_ID,
    });
    msgCounter = 0;
  });

  test("stranger's reaction is dropped — no challenge, session, conversation, or row", async () => {
    let agentDispatched = false;
    const processMessage = async (): Promise<{ messageId: string }> => {
      agentDispatched = true;
      return { messageId: "should-not-be-called" };
    };

    const req = buildReactionRequest("reaction:thumbsup", {
      actorExternalId: STRANGER_USER_ID,
      actorDisplayName: "Outside Reactor",
      actorUsername: "outsider",
    });
    const resp = await handleChannelInbound(
      req,
      processMessage,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    // Accepted as a passive signal — never denied or turned into a challenge.
    expect(json.accepted).toBe(true);
    expect(json.denied).not.toBe(true);
    expect(json.reason).not.toBe("verification_challenge_sent");
    expect(json.verificationSessionId).toBeUndefined();
    expect(agentDispatched).toBe(false);

    // No verification handshake, and no side effects: a dropped reaction leaves
    // no transcript row, no conversation, and no binding. (Sessions are
    // gateway-owned; the absent challenge is asserted via the response above.)
    expect(readPersistedMessages().length).toBe(0);
    expect(tableCount("conversations")).toBe(0);
    expect(tableCount("external_conversation_bindings")).toBe(0);
  });

  test("known contact's reaction is recorded — no challenge", async () => {
    // A pending contact classifies as `unverified_contact` — a known tier, so
    // its reactions are recorded. On a real message it would be re-challenged,
    // but a reaction must not trigger that.
    seedContactChannel({
      sourceChannel: "slack",
      externalUserId: CONTACT_USER_ID,
      externalChatId: SLACK_CHANNEL_ID,
      status: "pending",
      policy: "allow",
      displayName: "Pending Contact",
    });

    seedStoredMessage("1700000000.111111");
    const req = buildReactionRequest("reaction:tada", {
      actorExternalId: CONTACT_USER_ID,
      actorDisplayName: "Pending Contact",
      actorUsername: "pending_contact",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).not.toBe(true);
    expect(json.reason).not.toBe("verification_challenge_sent");

    const rows = readPersistedMessages().filter(
      (r) => r.content === "[reaction]",
    );
    expect(rows.length).toBe(1);
    const envelope = JSON.parse(rows[0].metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(envelope.slackMeta as string);
    expect(slackMeta?.eventKind).toBe("reaction");
    expect(slackMeta?.reaction?.emoji).toBe("tada");
  });
});
