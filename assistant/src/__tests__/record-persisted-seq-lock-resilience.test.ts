/**
 * Regression: `recordConversationPersistedSeq` must not throw on transient
 * SQLite write contention.
 *
 * The persisted-seq anchor is written from the agent loop as fire-and-forget
 * bookkeeping (`flushAccumulatedContent`, `handleMessageComplete`, tool
 * events). Before this resilience layer the write went through a bare
 * `rawRun`, so a `SQLITE_BUSY` ("database is locked") threw raw: on the
 * debounced partial-flush path it surfaced as an unhandled promise rejection,
 * and on the `message_complete` path it hit `dispatchAgentEvent`'s re-throw
 * allowlist — either one tripped the daemon's fail-fast shutdown and crashed
 * the process.
 *
 * These tests pin the two guarantees:
 *  1. A retryable `SQLITE_BUSY` is swallowed (the anchor simply does not
 *     advance) and self-heals on the next successful record.
 *  2. A non-retryable error (a genuine bug) still propagates.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Wrap the real raw-query module so the persisted-seq UPDATE can be made to
// throw on demand while every other DB call (createConversation, the read-back
// via `rawGet`) keeps hitting the real database.
//
// Destructure the real exports into stable locals BEFORE registering the mock:
// `mock.module` mutates the live module namespace in place, so reading
// `actualRawQuery.rawRun` from inside the factory would re-resolve to the mock
// and recurse forever. The captured `realRawRun` const is immune to that swap.
const actualRawQuery = await import("../persistence/raw-query.js");
const realRawRun = actualRawQuery.rawRun;

let injectedRecordError: Error | null = null;

mock.module("../persistence/raw-query.js", () => ({
  ...actualRawQuery,
  rawRun: (label: string, sql: string, ...params: unknown[]): number => {
    if (label === "conversation:recordPersistedSeq" && injectedRecordError) {
      throw injectedRecordError;
    }
    return (realRawRun as (...a: unknown[]) => number)(label, sql, ...params);
  },
}));

import {
  createConversation,
  getConversationPersistedSeq,
  recordConversationPersistedSeq,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function sqliteError(code: string): Error {
  return Object.assign(new Error("database is locked"), { code });
}

describe("recordConversationPersistedSeq write-contention resilience", () => {
  beforeEach(() => {
    injectedRecordError = null;
  });

  test("swallows a transient SQLITE_BUSY and self-heals on the next record", () => {
    // GIVEN a conversation with a recorded baseline anchor
    const conv = createConversation();
    recordConversationPersistedSeq(conv.id, 10);
    expect(getConversationPersistedSeq(conv.id)).toBe(10);

    // WHEN the anchor-advancing write loses the write-lock race
    injectedRecordError = sqliteError("SQLITE_BUSY");
    expect(() => recordConversationPersistedSeq(conv.id, 20)).not.toThrow();

    // THEN the anchor is simply left un-advanced (no crash, no regression) ...
    expect(getConversationPersistedSeq(conv.id)).toBe(10);

    // ... and the next contention-free record advances it (self-healing).
    injectedRecordError = null;
    recordConversationPersistedSeq(conv.id, 20);
    expect(getConversationPersistedSeq(conv.id)).toBe(20);
  });

  test("swallows the extended-result-code SQLITE_BUSY_SNAPSHOT too", () => {
    const conv = createConversation();
    injectedRecordError = sqliteError("SQLITE_BUSY_SNAPSHOT");
    expect(() => recordConversationPersistedSeq(conv.id, 5)).not.toThrow();
    expect(getConversationPersistedSeq(conv.id)).toBeNull();
  });

  test("rethrows a non-retryable SQLite error (a genuine bug)", () => {
    const conv = createConversation();
    injectedRecordError = sqliteError("SQLITE_ERROR");
    expect(() => recordConversationPersistedSeq(conv.id, 5)).toThrow(
      "database is locked",
    );
  });
});
