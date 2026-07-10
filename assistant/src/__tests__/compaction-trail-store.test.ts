/**
 * Tests for the compaction-trail store helper `getCompactionLogsBetween`.
 *
 * Exercises the SQL directly against a real in-memory DB — same pattern
 * as `llm-request-log-turn-query.test.ts`. Each test sets up a small
 * conversation, inserts a mix of `mainAgent` / `compactionAgent` /
 * NULL-call-site rows with controlled `createdAt` timestamps, and
 * asserts the right subset comes back.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { eq } from "drizzle-orm";

import { createConversation } from "../persistence/conversation-crud.js";
import { getDb, getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getCompactionLogsBetween,
  getRequestLogMetaById,
  recordRequestLog,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs } from "../persistence/schema/index.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  // llm_request_logs lives in the dedicated logs connection.
  getLogsDb()!.delete(llmRequestLogs).run();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Insert a log row and overwrite its `createdAt` so tests can assert
 * order/cutoff without relying on `Date.now()` timing.
 */
function insertLogAt(
  conversationId: string,
  createdAt: number,
  callSite: "mainAgent" | "compactionAgent" | null,
  requestPayload = "{}",
): string {
  // Logging is enabled in these tests, so the write always returns an id.
  const id = recordRequestLog(
    conversationId,
    requestPayload,
    "{}",
    undefined,
    "anthropic",
    callSite ?? undefined,
  )!;
  // Use the Drizzle update builder rather than `db.run("UPDATE … ?")` —
  // the drizzle wrapper doesn't accept positional parameters the same
  // way `bun:sqlite` does, and a silent no-op there manifests as zero
  // rows in the query under test (the inserted `created_at` keeps its
  // `Date.now()` value and ends up far in the future of the cutoff).
  getLogsDb()!
    .update(llmRequestLogs)
    .set({ createdAt })
    .where(eq(llmRequestLogs.id, id))
    .run();
  return id;
}

describe("getCompactionLogsBetween", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns only compactionAgent rows in the conversation, in the (after, before) window", () => {
    const conv = createConversation("test-conv");

    // Timeline (createdAt in ms):
    //   100 → compactionAgent  ← excluded (before the floor — would belong to an earlier turn)
    //   150 ← floor (the prior real call's createdAt)
    //   200 → mainAgent        ← excluded (wrong call site)
    //   300 → compactionAgent  ← included
    //   400 → null call site   ← excluded (pre-migration row, not a compaction)
    //   500 ← ceiling (the selected call's createdAt)
    //   600 → compactionAgent  ← excluded (after ceiling)
    insertLogAt(conv.id, 100, "compactionAgent");
    insertLogAt(conv.id, 200, "mainAgent");
    insertLogAt(conv.id, 300, "compactionAgent");
    insertLogAt(conv.id, 400, null);
    insertLogAt(conv.id, 600, "compactionAgent");

    const result = getCompactionLogsBetween(conv.id, 150, 500);
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe(300);
    expect(result[0]!.callSite).toBe("compactionAgent");
    expect(result[0]!.conversationId).toBe(conv.id);
  });

  test("null floor matches all compactions before the ceiling (first-real-call case)", () => {
    const conv = createConversation("null-floor");

    insertLogAt(conv.id, 100, "compactionAgent");
    insertLogAt(conv.id, 200, "compactionAgent");
    insertLogAt(conv.id, 300, "compactionAgent");
    insertLogAt(conv.id, 600, "compactionAgent");

    const result = getCompactionLogsBetween(conv.id, null, 500);
    expect(result.map((r) => r.createdAt)).toEqual([100, 200, 300]);
  });

  test("uses strict < at the ceiling (a row exactly at the cutoff is excluded)", () => {
    const conv = createConversation("strict-ceiling");

    insertLogAt(conv.id, 100, "compactionAgent");
    insertLogAt(conv.id, 500, "compactionAgent"); // exactly at the ceiling

    const result = getCompactionLogsBetween(conv.id, null, 500);
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe(100);
  });

  test("uses strict > at the floor (a row exactly at the floor is excluded)", () => {
    const conv = createConversation("strict-floor");

    insertLogAt(conv.id, 150, "compactionAgent"); // exactly at the floor
    insertLogAt(conv.id, 200, "compactionAgent");

    const result = getCompactionLogsBetween(conv.id, 150, 500);
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe(200);
  });

  test("scopes by conversation_id (other conversations are invisible)", () => {
    const a = createConversation("conv-a");
    const b = createConversation("conv-b");

    insertLogAt(a.id, 100, "compactionAgent");
    insertLogAt(b.id, 150, "compactionAgent");
    insertLogAt(a.id, 200, "compactionAgent");

    const result = getCompactionLogsBetween(a.id, null, 500);
    expect(result).toHaveLength(2);
    for (const row of result) {
      expect(row.conversationId).toBe(a.id);
    }
  });

  test("returns rows in chronological order by createdAt then id", () => {
    const conv = createConversation("ordered");

    // Insert out of order to verify the ORDER BY clause does the work.
    insertLogAt(conv.id, 300, "compactionAgent");
    insertLogAt(conv.id, 100, "compactionAgent");
    insertLogAt(conv.id, 200, "compactionAgent");

    const result = getCompactionLogsBetween(conv.id, null, 500);
    expect(result.map((r) => r.createdAt)).toEqual([100, 200, 300]);
  });

  test("returns an empty array when no compaction rows fall in the window", () => {
    const conv = createConversation("empty");

    // mainAgent (wrong site) + compactionAgent after the ceiling.
    insertLogAt(conv.id, 100, "mainAgent");
    insertLogAt(conv.id, 600, "compactionAgent");

    const result = getCompactionLogsBetween(conv.id, null, 500);
    expect(result).toEqual([]);
  });

  test("returns an empty array for an unknown conversation_id", () => {
    const result = getCompactionLogsBetween("nonexistent-conv", null, 500);
    expect(result).toEqual([]);
  });

  test("computes requestMessageCount in SQL without returning the request payload", () => {
    // GIVEN compaction rows whose request payloads use each provider
    // shape (Anthropic/OpenAI `messages`, Gemini `contents`, OpenAI
    // Responses `input`), plus rows where the count can't be derived
    const conv = createConversation("msg-count");
    insertLogAt(
      conv.id,
      100,
      "compactionAgent",
      JSON.stringify({ messages: [{}, {}, {}] }),
    );
    insertLogAt(
      conv.id,
      200,
      "compactionAgent",
      JSON.stringify({ contents: [{}, {}] }),
    );
    insertLogAt(
      conv.id,
      300,
      "compactionAgent",
      JSON.stringify({ input: [{}] }),
    );
    insertLogAt(conv.id, 400, "compactionAgent", "not-json{{{");
    insertLogAt(conv.id, 500, "compactionAgent", JSON.stringify({}));

    // WHEN querying the trail window
    const result = getCompactionLogsBetween(conv.id, null, 600);

    // THEN each row carries the SQL-computed message count (null when
    // the payload is malformed or has no known message array)
    expect(result.map((r) => r.requestMessageCount)).toEqual([
      3,
      2,
      1,
      null,
      null,
    ]);
    // AND the rows never include the request payload column
    for (const row of result) {
      expect("requestPayload" in row).toBe(false);
    }
  });
});

describe("getRequestLogMetaById", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns the row's metadata without either payload column", () => {
    // GIVEN a stored log row
    const conv = createConversation("meta-lookup");
    const id = insertLogAt(conv.id, 100, "compactionAgent", '{"big":true}');

    // WHEN looking it up by id
    const row = getRequestLogMetaById(id);

    // THEN the metadata comes back payload-free
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.conversationId).toBe(conv.id);
    expect(row!.createdAt).toBe(100);
    expect("requestPayload" in row!).toBe(false);
    expect("responsePayload" in row!).toBe(false);
  });

  test("returns null for an unknown id", () => {
    expect(getRequestLogMetaById("nonexistent")).toBeNull();
  });
});
