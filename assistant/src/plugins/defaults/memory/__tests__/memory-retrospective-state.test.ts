import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Disable memory so persistence writes don't index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import { createConversation } from "../../../../persistence/conversation-crud.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { memoryRetrospectiveState } from "../../../../persistence/schema/index.js";
import {
  appendToRememberedLog,
  bumpRetrospectiveLastRunAt,
  forkRetrospectiveState,
  getRetrospectiveState,
  REMEMBERED_LOG_MAX_BYTES,
  REMEMBERED_LOG_MAX_ENTRIES,
  upsertRetrospectiveState,
} from "../memory-retrospective-state.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(memoryRetrospectiveState).run();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("appendToRememberedLog", () => {
  test("appends new entries after existing ones, order preserved", () => {
    expect(appendToRememberedLog(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
    expect(appendToRememberedLog([], ["x"])).toEqual(["x"]);
    expect(appendToRememberedLog(["x"], [])).toEqual(["x"]);
  });

  test("entry cap keeps the most recent entries", () => {
    const existing = Array.from({ length: 99 }, (_, i) => `old-${i}`);
    const result = appendToRememberedLog(existing, ["new-1", "new-2", "new-3"]);

    expect(result).toHaveLength(REMEMBERED_LOG_MAX_ENTRIES);
    // Oldest entries dropped first.
    expect(result[0]).toBe("old-2");
    expect(result.at(-1)).toBe("new-3");
  });

  test("byte cap binds before the entry cap when entries are large", () => {
    // 20 entries of ~1 KB each — well under the entry cap but over 8 KB.
    const entries = Array.from(
      { length: 20 },
      (_, i) => `${i}-${"x".repeat(1024)}`,
    );
    const result = appendToRememberedLog([], entries);

    expect(result.length).toBeLessThan(entries.length);
    expect(result.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(REMEMBERED_LOG_MAX_BYTES);
    // Most recent entries survive.
    expect(result.at(-1)).toBe(entries.at(-1));
  });

  test("a single entry larger than the byte cap yields an empty log", () => {
    const huge = "y".repeat(REMEMBERED_LOG_MAX_BYTES + 1);
    expect(appendToRememberedLog([], [huge])).toEqual([]);
  });
});

describe("memory-retrospective-state remembered log persistence", () => {
  beforeEach(() => {
    resetTables();
  });

  test("upsert persists the log and getRetrospectiveState parses it back", () => {
    const conv = createConversation("Log thread");
    upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["save one", "save two"],
    });

    const state = getRetrospectiveState(conv.id);
    expect(state?.rememberedLog).toEqual(["save one", "save two"]);
    expect(state?.lastProcessedMessageId).toBe("m1");
  });

  test("upsert without rememberedLog preserves the stored log", () => {
    const conv = createConversation("Preserve thread");
    upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["keep me"],
    });
    upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "m2",
      lastRunAt: 2000,
    });

    const state = getRetrospectiveState(conv.id);
    expect(state?.lastProcessedMessageId).toBe("m2");
    expect(state?.rememberedLog).toEqual(["keep me"]);
  });

  test("missing/NULL column value parses as an empty log", () => {
    const conv = createConversation("Null-log thread");
    upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
    });

    expect(getRetrospectiveState(conv.id)?.rememberedLog).toEqual([]);
  });

  test("malformed stored JSON degrades to an empty log instead of throwing", () => {
    const conv = createConversation("Corrupt thread");
    upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["x"],
    });
    getDb()
      .update(memoryRetrospectiveState)
      .set({ rememberedLog: "not-json{{" })
      .where(eq(memoryRetrospectiveState.conversationId, conv.id))
      .run();

    expect(getRetrospectiveState(conv.id)?.rememberedLog).toEqual([]);
  });

  test("bumpRetrospectiveLastRunAt seeds the empty-string sentinel with an empty log and preserves an existing log", () => {
    // Failure-only row: "" sentinel, empty log.
    const fresh = createConversation("Failure-only thread");
    bumpRetrospectiveLastRunAt(fresh.id, 1000);
    const freshState = getRetrospectiveState(fresh.id);
    expect(freshState?.lastProcessedMessageId).toBe("");
    expect(freshState?.rememberedLog).toEqual([]);

    // Existing row with a log: a failure bump must not clobber it.
    const seasoned = createConversation("Seasoned thread");
    upsertRetrospectiveState({
      conversationId: seasoned.id,
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["survives failures"],
    });
    bumpRetrospectiveLastRunAt(seasoned.id, 2000);
    const seasonedState = getRetrospectiveState(seasoned.id);
    expect(seasonedState?.lastRunAt).toBe(2000);
    expect(seasonedState?.rememberedLog).toEqual(["survives failures"]);
  });

  test("forkRetrospectiveState copies the log verbatim to the forked child", () => {
    const source = createConversation("Fork source");
    const child = createConversation("Fork child");
    upsertRetrospectiveState({
      conversationId: source.id,
      lastProcessedMessageId: "",
      lastRunAt: 1000,
      rememberedLog: ["parent baseline"],
    });

    forkRetrospectiveState({
      database: getDb(),
      sourceConversationId: source.id,
      forkedConversationId: child.id,
      forkedMessageIds: new Map(),
      lastCopiedSourceMessageId: null,
    });

    expect(getRetrospectiveState(child.id)?.rememberedLog).toEqual([
      "parent baseline",
    ]);
  });
});
