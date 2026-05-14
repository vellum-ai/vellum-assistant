/**
 * Tests for queryUnreportedTurnEvents.
 *
 * Verifies that the JOIN to `conversations` correctly attaches the parent
 * conversation's `conversationType` to each returned turn, so analytics
 * downstream (DAU) can filter out background/scheduled prompts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { messages } from "../memory/schema.js";
import { queryUnreportedTurnEvents } from "../memory/turn-events-store.js";

initializeDb();

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
  test("attaches conversationType for standard conversations", async () => {
    const conv = createConversation({ conversationType: "standard" });
    await insertUserMessageAt(conv.id, "hello", 1000);

    const events = queryUnreportedTurnEvents(0, undefined, 100);
    expect(events.length).toBe(1);
    expect(events[0].conversationType).toBe("standard");
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
});
