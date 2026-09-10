import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  countMessagesAfter,
  getMessagesAfter,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resolveMessagesAfterBound } from "../persistence/message-cursor.js";
import { conversations, messages } from "../persistence/schema/index.js";

await initializeDb();

const CONV_ID = "conv-tiebreaker";

function clearDb(): void {
  const db = getDb();
  db.delete(messages).run();
  db.delete(conversations).run();
}

function seedConversation(): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id: CONV_ID,
      title: null,
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "default",
    })
    .run();
}

function insertMessage(id: string, createdAt: number): void {
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId: CONV_ID,
      role: "user",
      content: "",
      createdAt,
      metadata: null,
    })
    .run();
}

describe("countMessagesAfter / getMessagesAfter — millisecond-collision tie-breaker", () => {
  beforeEach(() => {
    clearDb();
    seedConversation();
  });

  test("messages sharing a millisecond timestamp with the reference are NOT permanently skipped (countMessagesAfter)", () => {
    const ts = 1_700_000_000_000;
    // Both messages share the exact same createdAt — id "b" sorts after
    // id "a" lexicographically. Without a tie-breaker the second message
    // would never be counted.
    insertMessage("a", ts);
    insertMessage("b", ts);

    expect(countMessagesAfter(CONV_ID, "a")).toBe(1);
  });

  test("messages sharing a millisecond timestamp with the reference are NOT permanently skipped (getMessagesAfter)", () => {
    const ts = 1_700_000_000_000;
    insertMessage("a", ts);
    insertMessage("b", ts);

    const result = getMessagesAfter(CONV_ID, "a");
    expect(result.map((m) => m.id)).toEqual(["b"]);
  });

  test("strict-after semantics: a message with id sorting BEFORE the reference but identical timestamp is NOT included", () => {
    const ts = 1_700_000_000_000;
    // "a" sorts before "b". Reference is "b", so "a" should be excluded
    // (strictly-after semantics, not "all rows at the same timestamp").
    insertMessage("a", ts);
    insertMessage("b", ts);

    expect(countMessagesAfter(CONV_ID, "b")).toBe(0);
    expect(getMessagesAfter(CONV_ID, "b")).toEqual([]);
  });

  test("mixed collision + later timestamps: counts both same-ts tie-breaker rows and strictly-later rows", () => {
    const ts = 1_700_000_000_000;
    insertMessage("a", ts);
    insertMessage("b", ts);
    insertMessage("c", ts);
    insertMessage("d", ts + 1);

    expect(countMessagesAfter(CONV_ID, "a")).toBe(3);
    const result = getMessagesAfter(CONV_ID, "a");
    expect(result.map((m) => m.id)).toEqual(["b", "c", "d"]);
  });

  test("missing reference returns 0/[] (conservative semantics preserved)", () => {
    insertMessage("a", 1_700_000_000_000);
    expect(countMessagesAfter(CONV_ID, "nonexistent")).toBe(0);
    expect(getMessagesAfter(CONV_ID, "nonexistent")).toEqual([]);
  });

  test("null/empty reference still returns all messages", () => {
    const ts = 1_700_000_000_000;
    insertMessage("a", ts);
    insertMessage("b", ts);

    expect(countMessagesAfter(CONV_ID, null)).toBe(2);
    expect(countMessagesAfter(CONV_ID, "")).toBe(2);
    expect(getMessagesAfter(CONV_ID, null)).toHaveLength(2);
    expect(getMessagesAfter(CONV_ID, "")).toHaveLength(2);
  });
});

describe("countMessagesAfter / getMessagesAfter: a cursor survives its row's deletion", () => {
  beforeEach(() => {
    clearDb();
    seedConversation();
  });

  test("a cursor carrying createdAt keeps bounding the read after its row is deleted", () => {
    const ts = 1_700_000_000_000;
    insertMessage("a", ts);
    // The row the cursor points at: a reply the user then regenerates.
    insertMessage("b", ts + 1);
    insertMessage("c", ts + 2);
    getDb().delete(messages).where(eq(messages.id, "b")).run();
    // The regenerated reply.
    insertMessage("d", ts + 3);

    const cursor = { id: "b", createdAt: ts + 1 };
    expect(countMessagesAfter(CONV_ID, cursor)).toBe(2);
    expect(getMessagesAfter(CONV_ID, cursor).map((m) => m.id)).toEqual([
      "c",
      "d",
    ]);
  });

  test("a cursor without createdAt keeps the conservative id-only semantics once its row is gone", () => {
    insertMessage("a", 1_700_000_000_000);

    const cursor = { id: "nonexistent", createdAt: null };
    expect(countMessagesAfter(CONV_ID, cursor)).toBe(0);
    expect(getMessagesAfter(CONV_ID, cursor)).toEqual([]);
  });

  test("the live row wins over the timestamp the cursor carries", () => {
    const ts = 1_700_000_000_000;
    insertMessage("a", ts);
    insertMessage("b", ts + 10);

    // A stale cursor timestamp must not pull processed rows back in, nor
    // hide unprocessed ones, while the row itself can still be read.
    expect(countMessagesAfter(CONV_ID, { id: "b", createdAt: ts - 100 })).toBe(
      0,
    );
    expect(countMessagesAfter(CONV_ID, { id: "a", createdAt: ts + 999 })).toBe(
      1,
    );
  });

  test("a cursor with an empty id reads everything, like null and the empty string", () => {
    insertMessage("a", 1_700_000_000_000);

    expect(countMessagesAfter(CONV_ID, { id: "", createdAt: 5 })).toBe(1);
    expect(getMessagesAfter(CONV_ID, { id: "", createdAt: 5 })).toHaveLength(1);
  });
});

describe("resolveMessagesAfterBound", () => {
  beforeEach(() => {
    clearDb();
    seedConversation();
  });

  test("resolves the unbounded, live-row, stored-timestamp, and vanished cases", () => {
    insertMessage("a", 1_000);

    expect(resolveMessagesAfterBound(null)).toEqual({ kind: "all" });
    expect(resolveMessagesAfterBound("")).toEqual({ kind: "all" });
    expect(resolveMessagesAfterBound({ id: "", createdAt: 3 })).toEqual({
      kind: "all",
    });
    expect(resolveMessagesAfterBound("a")).toEqual({
      kind: "after",
      bound: { createdAt: 1_000, id: "a" },
    });
    expect(resolveMessagesAfterBound({ id: "a", createdAt: 99 })).toEqual({
      kind: "after",
      bound: { createdAt: 1_000, id: "a" },
    });
    expect(resolveMessagesAfterBound("gone")).toEqual({ kind: "vanished" });
    expect(resolveMessagesAfterBound({ id: "gone", createdAt: null })).toEqual({
      kind: "vanished",
    });
    expect(resolveMessagesAfterBound({ id: "gone", createdAt: 7 })).toEqual({
      kind: "after",
      bound: { createdAt: 7, id: "gone" },
    });
  });
});
