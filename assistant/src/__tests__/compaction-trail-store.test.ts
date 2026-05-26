/**
 * Tests for `getCompactionLogsBeforeCall` in the LLM request log store.
 *
 * Exercises the SQL directly against a real in-memory DB — same pattern
 * as `llm-request-log-turn-query.test.ts`. Each test sets up a small
 * conversation, inserts a mix of `mainAgent` and `compactionAgent` rows
 * with controlled createdAt timestamps, and asserts the right subset
 * comes back.
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
    secretDetection: { enabled: false },
  }),
}));

import { eq } from "drizzle-orm";

import { createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getCompactionLogsBeforeCall,
  recordRequestLog,
} from "../memory/llm-request-log-store.js";
import { llmRequestLogs } from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(llmRequestLogs).run();
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
): string {
  const id = recordRequestLog(
    conversationId,
    "{}",
    "{}",
    undefined,
    "anthropic",
    callSite ?? undefined,
  );
  // Use the Drizzle update builder rather than `db.run("UPDATE … ?")` —
  // the drizzle wrapper doesn't accept positional parameters the same
  // way `bun:sqlite` does, and a silent no-op there manifests as zero
  // rows in the query under test (the inserted `created_at` keeps its
  // `Date.now()` value and ends up far in the future of the cutoff).
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ createdAt })
    .where(eq(llmRequestLogs.id, id))
    .run();
  return id;
}

describe("getCompactionLogsBeforeCall", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns only compactionAgent rows in the conversation, before the cutoff", () => {
    const conv = createConversation("test-conv");

    // Timeline (createdAt in ms):
    //   100 → compactionAgent  ← included
    //   200 → mainAgent        ← excluded (wrong call site)
    //   300 → compactionAgent  ← included
    //   400 → null call site   ← excluded (pre-migration row)
    //   500 ← cutoff (the selected call's createdAt)
    //   600 → compactionAgent  ← excluded (after cutoff)
    insertLogAt(conv.id, 100, "compactionAgent");
    insertLogAt(conv.id, 200, "mainAgent");
    insertLogAt(conv.id, 300, "compactionAgent");
    insertLogAt(conv.id, 400, null);
    insertLogAt(conv.id, 600, "compactionAgent");

    const result = getCompactionLogsBeforeCall(conv.id, 500);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.createdAt)).toEqual([100, 300]);
    for (const row of result) {
      expect(row.callSite).toBe("compactionAgent");
      expect(row.conversationId).toBe(conv.id);
    }
  });

  test("uses strict < at the cutoff (a row exactly at the cutoff is excluded)", () => {
    const conv = createConversation("strict-cutoff");

    insertLogAt(conv.id, 100, "compactionAgent");
    // This one sits exactly at the cutoff — must be excluded so the
    // selected call never appears in its own trail.
    insertLogAt(conv.id, 500, "compactionAgent");

    const result = getCompactionLogsBeforeCall(conv.id, 500);
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe(100);
  });

  test("scopes by conversation_id (other conversations are invisible)", () => {
    const a = createConversation("conv-a");
    const b = createConversation("conv-b");

    insertLogAt(a.id, 100, "compactionAgent");
    insertLogAt(b.id, 150, "compactionAgent");
    insertLogAt(a.id, 200, "compactionAgent");

    const result = getCompactionLogsBeforeCall(a.id, 500);
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

    const result = getCompactionLogsBeforeCall(conv.id, 500);
    expect(result.map((r) => r.createdAt)).toEqual([100, 200, 300]);
  });

  test("returns an empty array when there are no compaction rows before the cutoff", () => {
    const conv = createConversation("empty");

    // All rows are either the wrong call site or after the cutoff.
    insertLogAt(conv.id, 100, "mainAgent");
    insertLogAt(conv.id, 600, "compactionAgent");

    const result = getCompactionLogsBeforeCall(conv.id, 500);
    expect(result).toEqual([]);
  });

  test("returns an empty array for an unknown conversation_id", () => {
    const result = getCompactionLogsBeforeCall("nonexistent-conv", 500);
    expect(result).toEqual([]);
  });
});
