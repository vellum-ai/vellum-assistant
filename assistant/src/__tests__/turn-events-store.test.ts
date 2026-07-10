/**
 * Tests for queryUnreportedTurnEvents.
 *
 * Verifies that the JOIN to `conversations` correctly attaches the parent
 * conversation's `conversationType` to each returned turn, so analytics
 * downstream (DAU) can filter out background/scheduled prompts.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages } from "../persistence/schema/index.js";
import { queryUnreportedTurnEvents } from "../telemetry/turn-events-store.js";
import { stampTurnOutcome } from "../telemetry/turn-outcome.js";

await initializeDb();

function purge(): void {
  const db = getDb();
  // Wipe messages then conversations to keep tests independent. FK cascade
  // also removes any dependent rows.
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

beforeEach(() => {
  purge();
});

/**
 * Insert a user message at a specific epoch-millis timestamp so we can
 * assert ordering and the watermark cursor.
 */
async function insertUserMessageAt(
  conversationId: string,
  content: string,
  createdAt: number,
): Promise<string> {
  const message = await addMessage(conversationId, "user", content);
  // addMessage stamps createdAt to monotonic now(); rewrite for
  // deterministic ordering in the test.
  const db = getDb();
  db.run(
    `UPDATE messages SET created_at = ${createdAt} WHERE id = '${message.id}'`,
  );
  return message.id;
}

describe("queryUnreportedTurnEvents", () => {
  test("attaches conversationId, conversationType, and turnIndex for a standard conversation", async () => {
    const conv = createConversation({ conversationType: "standard" });
    await insertUserMessageAt(conv.id, "hello", 1000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    expect(events.length).toBe(1);
    expect(events[0].conversationId).toBe(conv.id);
    expect(events[0].conversationType).toBe("standard");
    // The single user message in this conversation is turn 1.
    expect(events[0].turnIndex).toBe(1);
  });

  test("attaches conversationType for background and scheduled conversations", async () => {
    const bg = createConversation({ conversationType: "background" });
    const sched = createConversation({ conversationType: "scheduled" });
    const std = createConversation({ conversationType: "standard" });

    const bgMsg = await insertUserMessageAt(bg.id, "bg prompt", 1000);
    const schedMsg = await insertUserMessageAt(sched.id, "sched prompt", 2000);
    const stdMsg = await insertUserMessageAt(std.id, "user typed this", 3000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));

    expect(byId[bgMsg].conversationType).toBe("background");
    expect(byId[schedMsg].conversationType).toBe("scheduled");
    expect(byId[stdMsg].conversationType).toBe("standard");
  });

  test("excludes tool_result and web_search_tool_result content patterns", async () => {
    const conv = createConversation({ conversationType: "standard" });

    // Real user turn
    const realId = await insertUserMessageAt(conv.id, "real user text", 1000);

    // Synthetic "user" rows that wrap tool results: these should be filtered
    const db = getDb();
    db.insert(messages)
      .values({
        id: "tool-result-id",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "x", content: "" },
        ]),
        createdAt: 2000,
      })
      .run();
    db.insert(messages)
      .values({
        id: "web-search-tool-result-id",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([
          { type: "web_search_tool_result", tool_use_id: "y", content: "" },
        ]),
        createdAt: 3000,
      })
      .run();

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(realId);
    expect(events[0].conversationType).toBe("standard");
    // Tool-result rows must NOT increment the turn index: this is the
    // only real user turn in the conversation, so its index is 1 even
    // though two synthetic role="user" rows exist with later timestamps.
    expect(events[0].turnIndex).toBe(1);
  });

  test("turnIndex counts real user turns in (createdAt, id) order within a conversation", async () => {
    const conv = createConversation({ conversationType: "standard" });
    const m1 = await insertUserMessageAt(conv.id, "first", 1000);
    const m2 = await insertUserMessageAt(conv.id, "second", 2000);
    const m3 = await insertUserMessageAt(conv.id, "third", 3000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    expect(byId[m1].turnIndex).toBe(1);
    expect(byId[m2].turnIndex).toBe(2);
    expect(byId[m3].turnIndex).toBe(3);
  });

  test("turnIndex resets across conversations", async () => {
    const a = createConversation({ conversationType: "standard" });
    const b = createConversation({ conversationType: "standard" });
    const a1 = await insertUserMessageAt(a.id, "a first", 1000);
    const b1 = await insertUserMessageAt(b.id, "b first", 1500);
    const a2 = await insertUserMessageAt(a.id, "a second", 2000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    // Conversation A: 1, 2. Conversation B: 1 (independent of A).
    expect(byId[a1].turnIndex).toBe(1);
    expect(byId[a2].turnIndex).toBe(2);
    expect(byId[b1].turnIndex).toBe(1);
    // And the conversation_id labels them correctly.
    expect(byId[a1].conversationId).toBe(a.id);
    expect(byId[b1].conversationId).toBe(b.id);
  });

  test("turnIndex skips tool_result rows even when they're interleaved", async () => {
    const conv = createConversation({ conversationType: "standard" });
    const real1 = await insertUserMessageAt(conv.id, "first real", 1000);

    // Inject a tool_result row between the two real turns. The
    // correlated subquery must use the same content filter as the
    // outer query, otherwise turn_index would jump by 2 instead of 1.
    const db = getDb();
    db.insert(messages)
      .values({
        id: "interleaved-tool-result",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "x", content: "" },
        ]),
        createdAt: 1500,
      })
      .run();

    const real2 = await insertUserMessageAt(conv.id, "second real", 2000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    expect(events.length).toBe(2);
    expect(byId[real1].turnIndex).toBe(1);
    expect(byId[real2].turnIndex).toBe(2);
  });

  test("respects the cursor and returns events in (createdAt, id) order", async () => {
    const conv = createConversation({ conversationType: "standard" });
    const m1 = await insertUserMessageAt(conv.id, "first", 1000);
    const m2 = await insertUserMessageAt(conv.id, "second", 2000);
    const m3 = await insertUserMessageAt(conv.id, "third", 3000);

    // Cursor at (1500, undefined) should skip m1 and return m2, m3 in order.
    const after = queryUnreportedTurnEvents(1500, undefined, 100);
    expect(after.map((e) => e.id)).toEqual([m2, m3]);

    // Sanity: pulling from the start returns all three with correct types.
    const all = queryUnreportedTurnEvents(0, undefined, 100);
    expect(all.map((e) => e.id)).toEqual([m1, m2, m3]);
    for (const e of all) {
      expect(e.conversationType).toBe("standard");
    }
  });

  test("extracts interfaceId, channelId, and clientMetadata from messages.metadata", async () => {
    // Three user messages with different metadata shapes to cover the
    // realistic spectrum of attribution carried on messages.metadata:
    //  - Full interactive: macOS surface, vellum channel, with a client
    //    block stamped by the (forthcoming) HTTP header middleware.
    //  - Channel inbound: Slack surface, no client headers (channel
    //    inbound paths don't carry browser context).
    //  - Legacy: a message persisted before metadata threading existed.
    const conv = createConversation({ conversationType: "standard" });

    const macOsMsg = await addMessage(conv.id, "user", "hi from desktop", {
      metadata: {
        userMessageInterface: "macos",
        userMessageChannel: "vellum",
        client: {
          os: "darwin",
          interface_version: "0.8.2",
        },
      },
    });
    const slackMsg = await addMessage(conv.id, "user", "hi from slack", {
      metadata: {
        userMessageInterface: "slack",
        userMessageChannel: "slack",
      },
    });
    const legacyMsg = await addMessage(conv.id, "user", "hi from the past");

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));

    expect(byId[macOsMsg.id]).toBeDefined();
    expect(byId[macOsMsg.id].interfaceId).toBe("macos");
    expect(byId[macOsMsg.id].channelId).toBe("vellum");
    // clientMetadata is returned as raw JSON text -- the reporter parses it.
    // We verify it round-trips back to the input object.
    expect(byId[macOsMsg.id].clientMetadata).not.toBeNull();
    expect(
      JSON.parse(byId[macOsMsg.id].clientMetadata as string),
    ).toMatchObject({
      os: "darwin",
      interface_version: "0.8.2",
    });

    expect(byId[slackMsg.id].interfaceId).toBe("slack");
    expect(byId[slackMsg.id].channelId).toBe("slack");
    expect(byId[slackMsg.id].clientMetadata).toBeNull();

    // Legacy rows (no metadata threading) return null for all three
    // attribution fields -- downstream analytics treats these as
    // "unknown" without breaking the batch.
    expect(byId[legacyMsg.id].interfaceId).toBeNull();
    expect(byId[legacyMsg.id].channelId).toBeNull();
    expect(byId[legacyMsg.id].clientMetadata).toBeNull();
  });

  test("projects turn-outcome stamps from messages.metadata", async () => {
    const conv = createConversation({ conversationType: "standard" });
    const head = await addMessage(conv.id, "user", "first of a burst", {
      metadata: { userMessageInterface: "web", userMessageChannel: "vellum" },
    });
    const final = await addMessage(conv.id, "user", "second of a burst");
    const failed = await addMessage(conv.id, "user", "doomed turn");
    const cancelled = await addMessage(conv.id, "user", "stopped turn");
    const normal = await addMessage(conv.id, "user", "replied turn");

    stampTurnOutcome(head.id, "batched", { batchedInto: final.id });
    stampTurnOutcome(failed.id, "failed", {
      failureCode: "PROVIDER_RATE_LIMIT",
    });
    stampTurnOutcome(cancelled.id, "cancelled");

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));

    expect(byId[head.id].outcome).toBe("batched");
    expect(byId[head.id].batchedInto).toBe(final.id);
    expect(byId[head.id].failureCode).toBeNull();
    // The stamp shallow-merges into existing metadata: attribution keys
    // written at persist time survive.
    expect(byId[head.id].interfaceId).toBe("web");
    expect(byId[head.id].channelId).toBe("vellum");

    expect(byId[failed.id].outcome).toBe("failed");
    expect(byId[failed.id].failureCode).toBe("PROVIDER_RATE_LIMIT");
    expect(byId[failed.id].batchedInto).toBeNull();

    expect(byId[cancelled.id].outcome).toBe("cancelled");
    expect(byId[cancelled.id].batchedInto).toBeNull();
    expect(byId[cancelled.id].failureCode).toBeNull();

    // Unstamped turns (normal replies, pre-stamping rows) project null for
    // all three outcome fields.
    expect(byId[normal.id].outcome).toBeNull();
    expect(byId[normal.id].batchedInto).toBeNull();
    expect(byId[normal.id].failureCode).toBeNull();

    // The batch-final turn itself carries no stamp.
    expect(byId[final.id].outcome).toBeNull();
  });

  test("stampTurnOutcome never throws, even for a nonexistent message id", () => {
    expect(() => stampTurnOutcome("no-such-message", "failed")).not.toThrow();
  });
});
