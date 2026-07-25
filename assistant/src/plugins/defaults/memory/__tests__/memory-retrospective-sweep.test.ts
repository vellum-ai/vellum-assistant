import { beforeEach, describe, expect, mock, test } from "bun:test";

// Record enqueues instead of writing job rows — the sweep's scan/gate decision
// is the unit under test, not the jobs store's coalescing. The enqueue's own
// recursion/low-yield guards are covered by memory-retrospective-enqueue tests.
// `enqueueResult` simulates whether the real helper actually queued a job: a
// source it skips returns false, and the sweep must consume no budget for it.
let enqueueCalls: Array<{ conversationId: string; trigger: string }> = [];
let enqueueResult = true;
mock.module("../memory-retrospective-enqueue.js", () => ({
  enqueueMemoryRetrospectiveIfEnabled: (args: {
    conversationId: string;
    trigger: string;
  }) => {
    enqueueCalls.push(args);
    return enqueueResult;
  },
}));

import type { AssistantConfig } from "../../../../config/types.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../../persistence/auto-analysis-constants.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import {
  getDb,
  getMemorySqlite,
} from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { messages } from "../../../../persistence/schema/index.js";
import {
  MEMORY_RETROSPECTIVE_SOURCE,
  SKILL_CARD_MESSAGE_KIND,
} from "../memory-retrospective-constants.js";
import { upsertRetrospectiveState } from "../memory-retrospective-state.js";
import {
  listSweepCandidateConversationIds,
  runRetrospectiveSweep,
} from "../memory-retrospective-sweep.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../v3/substrate/constants.js";

await initializeDb();

const SWEEP_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h

// High enough that the trust/interval/accounting tests never trip the cap; the
// cap-specific tests pass an explicit low value.
const DEFAULT_MAX_RUNS_PER_DAY = 10_000;

function makeConfig(
  opts: { sweepIntervalMs?: number; maxRunsPerAssistantPerDay?: number } = {},
): AssistantConfig {
  return {
    memory: {
      retrospective: {
        sweepIntervalMs: opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
        maxRunsPerAssistantPerDay:
          opts.maxRunsPerAssistantPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
      },
    },
  } as unknown as AssistantConfig;
}

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_daily_count`);
  db.run(`DELETE FROM conversations`);
}

/** Pre-seed a UTC day's retrospective attempt count on the memory connection. */
function seedDailyCount(now: number, count: number): void {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  getMemorySqlite()!
    .query(
      `INSERT INTO memory_retrospective_daily_count (day_key, run_count)
       VALUES (?, ?)
       ON CONFLICT(day_key) DO UPDATE SET run_count = excluded.run_count`,
    )
    .run(dayKey, count);
}

function readDailyCount(now: number): number {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const row = getMemorySqlite()!
    .query<
      { run_count: number },
      [string]
    >(`SELECT run_count FROM memory_retrospective_daily_count WHERE day_key = ?`)
    .get(dayKey);
  return row?.run_count ?? 0;
}

let messageSeq = 0;
function insertMessage(
  conversationId: string,
  opts: {
    role?: string;
    createdAt: number;
    metadata?: Record<string, unknown> | null;
  },
): string {
  const id = `msg-${String(++messageSeq).padStart(4, "0")}`;
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId,
      role: opts.role ?? "user",
      content: JSON.stringify([{ type: "text", text: "hello" }]),
      createdAt: opts.createdAt,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    })
    .run();
  return id;
}

describe("runRetrospectiveSweep", () => {
  beforeEach(() => {
    resetTables();
    enqueueCalls = [];
    enqueueResult = true;
  });

  test("never-run conversation with unprocessed messages is swept", async () => {
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 1, enqueued: 1 });
  });

  test("conversation with a recent attempt is skipped — the event triggers own it", async () => {
    const conv = createConversation({ id: "conv-a" });
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    insertMessage(conv.id, { createdAt: 2_000 }); // unprocessed, but...
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      // Within one sweep interval → responsive triggers are still covering it.
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS / 2,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("conversation stale past the interval with unprocessed messages is swept", async () => {
    const conv = createConversation({ id: "conv-a" });
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    insertMessage(conv.id, { createdAt: 2_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
  });

  test("conversation whose cursor is caught up is skipped (no unprocessed work)", async () => {
    const conv = createConversation({ id: "conv-a" });
    const latest = insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: latest,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("a card-only tail past the cursor does not count as unprocessed work", async () => {
    const conv = createConversation({ id: "conv-a" });
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });
    insertMessage(conv.id, {
      role: "assistant",
      createdAt: 2_000,
      metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("every eligible conversation is examined — a zero-work one does not starve a later one", async () => {
    // conv-a: caught up (zero work). conv-b: unprocessed. Ordered by id, the
    // zero-work conversation sorts first; the full scan must still reach conv-b.
    const a = createConversation({ id: "conv-a" });
    const aMsg = insertMessage(a.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: a.id,
      lastProcessedMessageId: aMsg,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    const b = createConversation({ id: "conv-b" });
    insertMessage(b.id, { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([{ conversationId: b.id, trigger: "sweep" }]);
    expect(result.scanned).toBe(2);
  });

  test("no work anywhere is a clean no-op", async () => {
    const result = await runRetrospectiveSweep(makeConfig());
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(enqueueCalls).toEqual([]);
  });

  test("untrusted-actor conversation is never swept, even with unprocessed messages", async () => {
    // A contact-audience conversation: the retrospective would run under
    // guardian trust with `remember`, so its content must not reach memory.
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, {
      createdAt: 1_000,
      metadata: { provenanceTrustClass: "unknown" },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("guardian-authored conversation is swept", async () => {
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, {
      createdAt: 1_000,
      metadata: { provenanceTrustClass: "guardian" },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
  });

  test("at the daily cap: no conversation is swept even with unprocessed work", async () => {
    const now = Date.now();
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, { createdAt: 1_000 });
    seedDailyCount(now, 40); // already at cap

    const result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );

    expect(enqueueCalls).toEqual([]);
    expect(result.enqueued).toBe(0);
  });

  test("halts once the shared daily budget is exhausted mid-pass", async () => {
    const now = Date.now();
    // Two conversations both have unprocessed work; the budget only affords one.
    createConversation({ id: "conv-a" });
    insertMessage("conv-a", { createdAt: 1_000 });
    createConversation({ id: "conv-b" });
    insertMessage("conv-b", { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 1 }),
      now,
    );

    // conv-a (sorted first) takes the last unit; conv-b is left for a later
    // pass once the budget refreshes.
    expect(enqueueCalls).toEqual([
      { conversationId: "conv-a", trigger: "sweep" },
    ]);
    expect(result.enqueued).toBe(1);
  });

  test("an eligible sweep enqueue consumes exactly one unit", async () => {
    const now = Date.now();
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, { createdAt: 1_000 });
    seedDailyCount(now, 5);

    const result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
    expect(result.enqueued).toBe(1);
    expect(readDailyCount(now)).toBe(6);
  });

  test("a sweep enqueue that coalesces into a pending job consumes no budget; a fresh creation after it completes consumes one", async () => {
    const now = Date.now();
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, { createdAt: 1_000 });
    seedDailyCount(now, 5);

    // A conversation already queued by an event trigger: the sweep's enqueue
    // coalesces into the pending row (helper returns false). No matter how many
    // sweep passes run while that job stays pending, none may drain the budget.
    enqueueResult = false;
    let result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );
    expect(result).toEqual({ scanned: 1, enqueued: 0 });
    expect(readDailyCount(now)).toBe(5);

    result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );
    expect(result.enqueued).toBe(0);
    expect(readDailyCount(now)).toBe(5);

    // Once that job completes, a later pass creates a genuinely new job → one
    // unit consumed.
    enqueueResult = true;
    result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );
    expect(result.enqueued).toBe(1);
    expect(readDailyCount(now)).toBe(6);
  });

  test("a source the enqueue helper skips consumes no budget and is not counted", async () => {
    const now = Date.now();
    const conv = createConversation({ id: "conv-a" });
    insertMessage(conv.id, { createdAt: 1_000 });
    seedDailyCount(now, 5);
    // The enqueue is attempted (budget under cap), but the helper skips this
    // source and queues nothing, so the day's count must not move and the sweep
    // reports it as scanned-not-enqueued.
    enqueueResult = false;

    const result = await runRetrospectiveSweep(
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
      now,
    );

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 1, enqueued: 0 });
    expect(readDailyCount(now)).toBe(5);
  });
});

describe("listSweepCandidateConversationIds", () => {
  beforeEach(() => {
    resetTables();
  });

  test("excludes retrospective, consolidation, auto-analysis, and scheduled sources; orders by id", () => {
    createConversation({ id: "conv-a" });
    createConversation({ id: "conv-b" });
    createConversation({
      id: "conv-retro",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    createConversation({
      id: "conv-consolidate",
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
    });
    createConversation({ id: "conv-auto", source: AUTO_ANALYSIS_SOURCE });
    createConversation({ id: "conv-scheduled", conversationType: "scheduled" });

    const ids = listSweepCandidateConversationIds("", 100);

    expect(ids).toEqual(["conv-a", "conv-b"]);
  });

  test("keyset cursor resumes past the given id", () => {
    createConversation({ id: "conv-a" });
    createConversation({ id: "conv-b" });
    createConversation({ id: "conv-c" });

    expect(listSweepCandidateConversationIds("conv-a", 100)).toEqual([
      "conv-b",
      "conv-c",
    ]);
    expect(listSweepCandidateConversationIds("", 1)).toEqual(["conv-a"]);
  });
});
