/**
 * Tests for handleListMessages `page=latest` initial-page mode.
 *
 * Verifies that:
 * - `page=latest` returns the newest N messages in chronological order.
 * - `page=latest` always emits `oldestTimestamp`/`oldestMessageId` (null when empty).
 * - `beforeTimestamp` wins over `page=latest` when both are sent.
 * - Invalid `page` values return 400.
 * - The no-param and `beforeTimestamp`-only paths keep their existing shapes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import { createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { messages } from "../memory/schema.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Seed `count` text messages with monotonically increasing `createdAt`.
 * Inserts directly via Drizzle so timestamps are deterministic — we need
 * sequential createdAt values (1, 2, 3, ...) to verify ordering and slicing
 * without racing against `monotonicNow()` from `addMessage`.
 *
 * Returns the seeded rows in chronological order (id `msg-1` ... `msg-N`).
 */
function seedMessages(
  conversationId: string,
  count: number,
): Array<{ id: string; createdAt: number; role: string }> {
  const db = getDb();
  const seeded: Array<{ id: string; createdAt: number; role: string }> = [];
  for (let i = 1; i <= count; i++) {
    const role = i % 2 === 1 ? "user" : "assistant";
    const id = `msg-${i}`;
    const createdAt = i;
    db.insert(messages)
      .values({
        id,
        conversationId,
        role,
        content: JSON.stringify([{ type: "text", text: `message ${i}` }]),
        createdAt,
      })
      .run();
    seeded.push({ id, createdAt, role });
  }
  return seeded;
}

interface MessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

interface ListResponse {
  messages: MessagePayload[];
  hasMore?: boolean;
  oldestTimestamp?: number | null;
  oldestMessageId?: string | null;
}

function callList(query: Record<string, string>): ListResponse {
  return handleListMessages(
    { queryParams: query },
    null,
  ) as unknown as ListResponse;
}

describe("handleListMessages page=latest", () => {
  beforeEach(resetTables);

  test("page=latest with no limit returns all messages chronologically", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages).toHaveLength(120);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[119].id).toBe("msg-120");
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });

  test("page=latest&limit=50 with 120 seeded messages returns newest 50 chronologically", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    const body = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
    });

    expect(body.messages).toHaveLength(50);
    // newest 50 are ids 71..120 (1..120 seeded)
    expect(body.messages[0].id).toBe("msg-71");
    expect(body.messages[49].id).toBe("msg-120");
    expect(body.hasMore).toBe(true);
    expect(body.oldestTimestamp).toBe(71);
    expect(body.oldestMessageId).toBe("msg-71");
  });

  test("page=latest&limit=50 with 10 seeded messages returns all 10 with hasMore=false", () => {
    const conv = createConversation();
    seedMessages(conv.id, 10);

    const body = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
    });

    expect(body.messages).toHaveLength(10);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[9].id).toBe("msg-10");
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });

  test("beforeTimestamp wins when combined with page=latest", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    // beforeTimestamp=100 + limit=50 should return msgs 50..99 (the 50 messages
    // immediately older than ts=100), regardless of the page=latest signal.
    const combinedBody = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
      beforeTimestamp: "100",
    });

    const beforeOnlyBody = callList({
      conversationId: conv.id,
      limit: "50",
      beforeTimestamp: "100",
    });

    expect(combinedBody.messages.map((m) => m.id)).toEqual(
      beforeOnlyBody.messages.map((m) => m.id),
    );
    expect(combinedBody.hasMore).toBe(beforeOnlyBody.hasMore);
    expect(combinedBody.oldestTimestamp).toBe(beforeOnlyBody.oldestTimestamp);
    expect(combinedBody.oldestMessageId).toBe(beforeOnlyBody.oldestMessageId);
    // Sanity-check the older-page slice itself.
    expect(combinedBody.messages).toHaveLength(50);
    expect(combinedBody.messages[0].id).toBe("msg-50");
    expect(combinedBody.messages[49].id).toBe("msg-99");
  });

  test("page=latest on empty conversation returns null pagination metadata", () => {
    const conv = createConversation();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBeNull();
    expect(body.oldestMessageId).toBeNull();
  });

  test("page=latest on unresolved conversationKey returns null metadata contract", () => {
    const body = callList({
      conversationKey: "no-such-key",
      page: "latest",
    });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBeNull();
    expect(body.oldestMessageId).toBeNull();
  });

  test("no-page GET on unresolved conversationKey keeps minimal shape", () => {
    const body = callList({ conversationKey: "no-such-key" });

    expect(body.messages).toEqual([]);
    expect("hasMore" in body).toBe(false);
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("page=invalid throws BadRequestError", () => {
    const conv = createConversation();

    expect(() =>
      handleListMessages(
        { queryParams: { conversationId: conv.id, page: "invalid" } },
        null,
      ),
    ).toThrow(BadRequestError);
    expect(() =>
      handleListMessages(
        { queryParams: { conversationId: conv.id, page: "invalid" } },
        null,
      ),
    ).toThrow("page must be 'latest' when provided");
  });

  test("no-param GET returns full history without pagination metadata", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    const body = callList({ conversationId: conv.id });

    expect(body.messages).toHaveLength(5);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[4].id).toBe("msg-5");
    // Regression: the no-param shape must NOT include pagination metadata.
    expect("hasMore" in body).toBe(false);
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("beforeTimestamp-only GET keeps existing conditional-metadata shape (no results)", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    // beforeTimestamp before all seeded rows => no results, metadata omitted.
    const body = callList({
      conversationId: conv.id,
      limit: "10",
      beforeTimestamp: "0",
    });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    // Existing contract: omit metadata when no rows. Must NOT regress to null.
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("beforeTimestamp-only GET keeps existing conditional-metadata shape (with results)", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    const body = callList({
      conversationId: conv.id,
      limit: "10",
      beforeTimestamp: "100",
    });

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });
});
