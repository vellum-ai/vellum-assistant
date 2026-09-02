import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Disable memory so persistence writes don't index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import {
  getDb,
  getMemorySqlite,
} from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
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

// `memory_retrospective_state` now lives on the dedicated memory connection and
// no longer carries a foreign key to `conversations`, so tests seed plain
// conversation ids without a backing conversation row.
function resetTables(): void {
  getMemorySqlite()!.exec("DELETE FROM memory_retrospective_state");
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
    upsertRetrospectiveState({
      conversationId: "conv-log",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["save one", "save two"],
    });

    const state = getRetrospectiveState("conv-log");
    expect(state?.rememberedLog).toEqual(["save one", "save two"]);
    expect(state?.lastProcessedMessageId).toBe("m1");
  });

  test("upsert without rememberedLog preserves the stored log", () => {
    upsertRetrospectiveState({
      conversationId: "conv-preserve",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["keep me"],
    });
    upsertRetrospectiveState({
      conversationId: "conv-preserve",
      lastProcessedMessageId: "m2",
      lastRunAt: 2000,
    });

    const state = getRetrospectiveState("conv-preserve");
    expect(state?.lastProcessedMessageId).toBe("m2");
    expect(state?.rememberedLog).toEqual(["keep me"]);
  });

  test("missing/NULL column value parses as an empty log", () => {
    upsertRetrospectiveState({
      conversationId: "conv-null-log",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
    });

    expect(getRetrospectiveState("conv-null-log")?.rememberedLog).toEqual([]);
  });

  test("malformed stored JSON degrades to an empty log instead of throwing", () => {
    upsertRetrospectiveState({
      conversationId: "conv-corrupt",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["x"],
    });
    getMemorySqlite()!
      .query(
        "UPDATE memory_retrospective_state SET remembered_log = ? WHERE conversation_id = ?",
      )
      .run("not-json{{", "conv-corrupt");

    expect(getRetrospectiveState("conv-corrupt")?.rememberedLog).toEqual([]);
  });

  test("upsert persists consecutiveFailures and getRetrospectiveState reads it back", () => {
    upsertRetrospectiveState({
      conversationId: "conv-failures",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      consecutiveFailures: 2,
    });

    expect(getRetrospectiveState("conv-failures")?.consecutiveFailures).toBe(2);
  });

  test("upsert without consecutiveFailures leaves the stored count untouched", () => {
    upsertRetrospectiveState({
      conversationId: "conv-keep-failures",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      consecutiveFailures: 2,
    });
    upsertRetrospectiveState({
      conversationId: "conv-keep-failures",
      lastProcessedMessageId: "m2",
      lastRunAt: 2000,
    });

    const state = getRetrospectiveState("conv-keep-failures");
    expect(state?.lastProcessedMessageId).toBe("m2");
    expect(state?.consecutiveFailures).toBe(2);
  });

  test("bumpRetrospectiveLastRunAt can record an incremented failure count", () => {
    upsertRetrospectiveState({
      conversationId: "conv-bump-failures",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      consecutiveFailures: 1,
    });
    bumpRetrospectiveLastRunAt("conv-bump-failures", 2000, {
      consecutiveFailures: 2,
    });

    const state = getRetrospectiveState("conv-bump-failures");
    expect(state?.lastProcessedMessageId).toBe("m1");
    expect(state?.lastRunAt).toBe(2000);
    expect(state?.consecutiveFailures).toBe(2);
  });

  test("success upsert resets consecutiveFailures to 0", () => {
    upsertRetrospectiveState({
      conversationId: "conv-reset-failures",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      consecutiveFailures: 2,
    });
    upsertRetrospectiveState({
      conversationId: "conv-reset-failures",
      lastProcessedMessageId: "m2",
      lastRunAt: 2000,
      consecutiveFailures: 0,
    });

    expect(
      getRetrospectiveState("conv-reset-failures")?.consecutiveFailures,
    ).toBe(0);
  });

  test("forkRetrospectiveState resets consecutiveFailures on the child", () => {
    upsertRetrospectiveState({
      conversationId: "conv-fork-fail-source",
      lastProcessedMessageId: "",
      lastRunAt: 1000,
      rememberedLog: ["parent baseline"],
      consecutiveFailures: 2,
    });

    forkRetrospectiveState({
      database: getDb(),
      sourceConversationId: "conv-fork-fail-source",
      forkedConversationId: "conv-fork-fail-child",
      forkedMessageIds: new Map(),
      lastCopiedSourceMessageId: null,
    });

    expect(getRetrospectiveState("conv-fork-fail-child")?.rememberedLog).toEqual(
      ["parent baseline"],
    );
    expect(
      getRetrospectiveState("conv-fork-fail-child")?.consecutiveFailures,
    ).toBe(0);
  });

  test("bumpRetrospectiveLastRunAt seeds the empty-string sentinel with an empty log and preserves an existing log", () => {
    // Failure-only row: "" sentinel, empty log.
    bumpRetrospectiveLastRunAt("conv-failure-only", 1000);
    const freshState = getRetrospectiveState("conv-failure-only");
    expect(freshState?.lastProcessedMessageId).toBe("");
    expect(freshState?.rememberedLog).toEqual([]);

    // Existing row with a log: a failure bump must not clobber it.
    upsertRetrospectiveState({
      conversationId: "conv-seasoned",
      lastProcessedMessageId: "m1",
      lastRunAt: 1000,
      rememberedLog: ["survives failures"],
    });
    bumpRetrospectiveLastRunAt("conv-seasoned", 2000);
    const seasonedState = getRetrospectiveState("conv-seasoned");
    expect(seasonedState?.lastRunAt).toBe(2000);
    expect(seasonedState?.rememberedLog).toEqual(["survives failures"]);
  });

  test("forkRetrospectiveState copies the log verbatim to the forked child", () => {
    upsertRetrospectiveState({
      conversationId: "conv-fork-source",
      lastProcessedMessageId: "",
      lastRunAt: 1000,
      rememberedLog: ["parent baseline"],
    });

    forkRetrospectiveState({
      // The main-DB handle is unused now; the write lands on the memory
      // connection.
      database: getDb(),
      sourceConversationId: "conv-fork-source",
      forkedConversationId: "conv-fork-child",
      forkedMessageIds: new Map(),
      lastCopiedSourceMessageId: null,
    });

    expect(getRetrospectiveState("conv-fork-child")?.rememberedLog).toEqual([
      "parent baseline",
    ]);
  });
});

describe("fail-soft when the underlying statement fails", () => {
  // The memory connection is present, but the relocated table is gone (a
  // corrupt/dropped table, SQLITE_FULL, I/O error, or SQLITE_BUSY after
  // timeout). The fork copy runs inside the main fork transaction, so it must
  // degrade like the null-connection case — log a warning and no-op — rather
  // than throwing out and aborting the user-visible fork. Dropped last so no
  // later test in this file sees the missing table.
  test("forkRetrospectiveState no-ops when the target table is missing", () => {
    getMemorySqlite()!.exec("DROP TABLE memory_retrospective_state");

    expect(() =>
      forkRetrospectiveState({
        database: getDb(),
        sourceConversationId: "conv-parent",
        forkedConversationId: "conv-child",
        forkedMessageIds: new Map(),
        lastCopiedSourceMessageId: null,
      }),
    ).not.toThrow();
  });
});
