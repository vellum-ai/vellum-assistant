import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  countMessagesAfter,
  getMessagesAfter,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { conversations, messages } from "../memory/schema.js";

initializeDb();

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
      memoryScopeId: "default",
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
