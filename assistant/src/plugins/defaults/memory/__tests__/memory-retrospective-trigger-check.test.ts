import { beforeEach, describe, expect, mock, test } from "bun:test";

// Record enqueues instead of writing job rows — the trigger decision is the
// unit under test here, not the jobs store's gating. `enqueueResult` simulates
// whether the real helper actually queued a job: an ineligible source (scheduled
// thread, consolidation source, recursion guard) returns false; a normal enqueue
// returns true. The daily budget must be consumed only on a true return.
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
import { createConversation } from "../../../../persistence/conversation-crud.js";
import {
  getDb,
  getMemorySqlite,
} from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { messages } from "../../../../persistence/schema/index.js";
import { SKILL_CARD_MESSAGE_KIND } from "../memory-retrospective-constants.js";
import { upsertRetrospectiveState } from "../memory-retrospective-state.js";
import {
  maybeEnqueueRetrospective,
  shouldEnqueueRetrospective,
} from "../memory-retrospective-trigger-check.js";

await initializeDb();

const THRESHOLDS = {
  timeThresholdMs: 30 * 60 * 1000, // 30 min
  messageThreshold: 10,
  minCooldownMs: 5 * 60 * 1000, // 5 min
};

describe("shouldEnqueueRetrospective", () => {
  test("no state — returns 'interval' regardless of message count", () => {
    const result = shouldEnqueueRetrospective({
      state: null,
      newMessageCount: 0,
      now: Date.now(),
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown gate — within minCooldownMs, returns null even if other thresholds would trip", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 60_000 }, // 1 min ago
      newMessageCount: 50, // way over threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("cooldown elapsed + time threshold reached — returns 'interval'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown elapsed + time threshold not reached + message threshold met — returns 'message_count'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 }, // past cooldown
      newMessageCount: 10, // exactly at threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("message_count");
  });

  test("cooldown elapsed + neither threshold met — returns null", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 },
      newMessageCount: 5, // below threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("time threshold at exact boundary — returns 'interval'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 30 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("mid-turn job skip leaves lastRunAt unbumped, so the turn-end trigger check fires immediately (event-driven requeue)", () => {
    // The job's `source_processing` skip does NOT bump `lastRunAt` (see
    // memory-retrospective-job.ts) precisely so the indexing pass on the
    // turn's final assistant message re-enqueues with no cooldown block.
    const now = Date.now();

    // Fresh conversation: the burned first run left no state row at all →
    // the first-run interval fires as soon as any message indexes.
    expect(
      shouldEnqueueRetrospective({
        state: null,
        newMessageCount: 1,
        now,
        ...THRESHOLDS,
      }),
    ).toBe("interval");

    // Established conversation: `lastRunAt` still reflects the run BEFORE
    // the skipped one, so the same threshold that tripped the skipped
    // enqueue trips again immediately.
    expect(
      shouldEnqueueRetrospective({
        state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
        newMessageCount: 1,
        now,
        ...THRESHOLDS,
      }),
    ).toBe("interval");
  });

  test("message threshold prefers 'message_count' label when both could fire (interval also at boundary)", () => {
    // When the interval is also at threshold AND there are also enough
    // new messages, interval wins because it's evaluated first — the
    // trigger label is for observability only, the action is the same.
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 20,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueRetrospective — kind-aware accounting (real DB).
//
// The retrospective's own `skill-authored-card` message is inserted AFTER the
// cursor the run just persisted, so it always sits past
// `lastProcessedMessageId`. It must never count as unprocessed conversation
// content: a card-only tail hits the zero-new-messages early-out (suppressing
// even the interval trigger), and mixed tails count only the real rows.
// ---------------------------------------------------------------------------

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  // `memory_retrospective_state` and the daily-attempt counter both live on
  // the memory connection now.
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_daily_count`);
  db.run(`DELETE FROM conversations`);
}

/** Today's UTC day key, matching `maybeEnqueueRetrospective`'s internal clock. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pre-seed today's retrospective attempt count on the memory connection. */
function seedDailyCount(count: number): void {
  getMemorySqlite()!
    .query(
      `INSERT INTO memory_retrospective_daily_count (day_key, run_count)
       VALUES (?, ?)
       ON CONFLICT(day_key) DO UPDATE SET run_count = excluded.run_count`,
    )
    .run(todayKey(), count);
}

function readDailyCount(): number {
  const row = getMemorySqlite()!
    .query<
      { run_count: number },
      [string]
    >(`SELECT run_count FROM memory_retrospective_daily_count WHERE day_key = ?`)
    .get(todayKey());
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
  const id = `msg-${++messageSeq}`;
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

function insertSkillCardMessage(
  conversationId: string,
  createdAt: number,
): string {
  return insertMessage(conversationId, {
    role: "assistant",
    createdAt,
    metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
  });
}

// High enough that the accounting tests never trip the cap; the cap-specific
// tests pass an explicit low value.
const DEFAULT_MAX_RUNS_PER_DAY = 10_000;

function makeConfig(
  overrides: Partial<typeof THRESHOLDS> & {
    maxRunsPerAssistantPerDay?: number;
  } = {},
): AssistantConfig {
  return {
    memory: {
      retrospective: {
        ...THRESHOLDS,
        maxRunsPerAssistantPerDay: DEFAULT_MAX_RUNS_PER_DAY,
        ...overrides,
      },
    },
  } as unknown as AssistantConfig;
}

describe("maybeEnqueueRetrospective — kind-aware accounting", () => {
  beforeEach(() => {
    resetTables();
    enqueueCalls = [];
    enqueueResult = true;
  });

  test("card-only tail past the cursor: no enqueue, even when the interval threshold has long elapsed", async () => {
    const conv = createConversation("conv");
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      // Way past the interval threshold — if the card counted as new work,
      // the interval trigger would fire.
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    insertSkillCardMessage(conv.id, 2_000);

    maybeEnqueueRetrospective(conv.id, makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("real message past the cursor still enqueues (the exclusion is card-specific)", async () => {
    const conv = createConversation("conv");
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    insertMessage(conv.id, { createdAt: 2_000 });

    maybeEnqueueRetrospective(conv.id, makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });

  test("message_count trigger counts only real messages, not interleaved cards", async () => {
    const conv = createConversation("conv");
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    // Cooldown elapsed, interval NOT reached — only message_count can fire.
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - 6 * 60_000,
    });
    insertSkillCardMessage(conv.id, 2_000);
    insertMessage(conv.id, { createdAt: 3_000 });

    // Card + 1 real = raw count 2 (at threshold), kind-aware count 1 → quiet.
    maybeEnqueueRetrospective(conv.id, makeConfig({ messageThreshold: 2 }));
    expect(enqueueCalls).toEqual([]);

    // A second real message tips the kind-aware count to the threshold.
    insertMessage(conv.id, { createdAt: 4_000 });
    maybeEnqueueRetrospective(conv.id, makeConfig({ messageThreshold: 2 }));
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "message_count" },
    ]);
  });

  test("no state row: a card-only conversation stays quiet; a real message fires the first-run interval", () => {
    const conv = createConversation("conv");
    insertSkillCardMessage(conv.id, 1_000);

    maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([]);

    insertMessage(conv.id, { createdAt: 2_000 });
    maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });

  test("'' cursor sentinel (failure-only state) counts everything except cards", async () => {
    const conv = createConversation("conv");
    // Failure-seeded rows carry the "" sentinel — treated like "no cursor".
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "",
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    insertSkillCardMessage(conv.id, 1_000);

    maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([]);

    insertMessage(conv.id, { createdAt: 2_000 });
    maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueRetrospective — daily runaway cap.
//
// The cap counts enqueue attempts across all conversations for the assistant in
// a UTC day. A trigger that would otherwise fire is skipped once the day's
// count reaches `maxRunsPerAssistantPerDay`. A firing enqueue reserves one unit
// of the day's budget.
// ---------------------------------------------------------------------------

describe("maybeEnqueueRetrospective — daily runaway cap", () => {
  beforeEach(() => {
    resetTables();
    enqueueCalls = [];
    enqueueResult = true;
  });

  test("at the cap: a would-be trigger is skipped and the count is untouched", () => {
    const conv = createConversation("conv");
    insertMessage(conv.id, { createdAt: 2_000 }); // first-run interval would fire
    seedDailyCount(40); // already at cap

    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );

    expect(enqueueCalls).toEqual([]);
    expect(readDailyCount()).toBe(40);
  });

  test("one below the cap: the enqueue fires and consumes the last unit", () => {
    const conv = createConversation("conv");
    insertMessage(conv.id, { createdAt: 2_000 });
    seedDailyCount(39);

    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
    expect(readDailyCount()).toBe(40);

    // A subsequent qualifying turn is now capped.
    insertMessage(conv.id, { createdAt: 3_000 });
    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
    expect(readDailyCount()).toBe(40);
  });

  test("the cap spans conversations: attempts from different conversations share the budget", () => {
    const a = createConversation("conv-a");
    const b = createConversation("conv-b");
    insertMessage(a.id, { createdAt: 2_000 });
    insertMessage(b.id, { createdAt: 2_000 });
    seedDailyCount(1);

    maybeEnqueueRetrospective(
      a.id,
      makeConfig({ maxRunsPerAssistantPerDay: 2 }),
    );
    maybeEnqueueRetrospective(
      b.id,
      makeConfig({ maxRunsPerAssistantPerDay: 2 }),
    );

    // conv-a takes the last unit; conv-b is capped even though it is a
    // different conversation.
    expect(enqueueCalls).toEqual([
      { conversationId: a.id, trigger: "interval" },
    ]);
    expect(readDailyCount()).toBe(2);
  });

  test("a would-be-quiet turn under the cap never touches the counter", async () => {
    const conv = createConversation("conv");
    const cutoff = insertMessage(conv.id, { createdAt: 1_000 });
    // Cooldown not elapsed and no new work → no trigger, so no reservation.
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - 60_000,
    });

    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );

    expect(enqueueCalls).toEqual([]);
    expect(readDailyCount()).toBe(0);
  });

  test("an ineligible source the enqueue helper skips consumes no budget", () => {
    const conv = createConversation("conv");
    insertMessage(conv.id, { createdAt: 2_000 }); // first-run interval fires
    seedDailyCount(5);
    // The trigger fires and the budget is under cap, so the enqueue is
    // attempted — but the helper skips this source (e.g. a scheduled thread or
    // consolidation conversation), returning false. Nothing was queued, so the
    // day's count must not move: a stream of low-yield turns can never exhaust
    // the budget on its own.
    enqueueResult = false;

    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
    expect(readDailyCount()).toBe(5);
  });

  test("an eligible enqueue consumes exactly one unit", () => {
    const conv = createConversation("conv");
    insertMessage(conv.id, { createdAt: 2_000 });
    seedDailyCount(5);

    maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ maxRunsPerAssistantPerDay: 40 }),
    );

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
    expect(readDailyCount()).toBe(6);
  });

  test("a trigger that coalesces into a pending job consumes no budget; a fresh job after it completes consumes one", () => {
    const conv = createConversation("conv");
    insertMessage(conv.id, { createdAt: 2_000 });
    seedDailyCount(5);
    const config = makeConfig({ maxRunsPerAssistantPerDay: 40 });

    // First qualifying turn creates the pending job → one unit consumed.
    enqueueResult = true;
    maybeEnqueueRetrospective(conv.id, config);
    expect(readDailyCount()).toBe(6);

    // Subsequent qualifying turns while that job is still pending only
    // coalesce (helper returns false). A slow/stopped worker could repeat this
    // arbitrarily many times — none of them may drain the day's budget.
    enqueueResult = false;
    insertMessage(conv.id, { createdAt: 3_000 });
    maybeEnqueueRetrospective(conv.id, config);
    insertMessage(conv.id, { createdAt: 4_000 });
    maybeEnqueueRetrospective(conv.id, config);
    expect(readDailyCount()).toBe(6);

    // Once the pending job completes, the next turn creates a genuinely new
    // job → one more unit consumed.
    enqueueResult = true;
    insertMessage(conv.id, { createdAt: 5_000 });
    maybeEnqueueRetrospective(conv.id, config);
    expect(readDailyCount()).toBe(7);
  });
});
