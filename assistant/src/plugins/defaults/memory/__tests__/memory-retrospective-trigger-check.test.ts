import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Record enqueues instead of writing job rows — the trigger decision is the
// unit under test here, not the jobs store's gating.
let enqueueCalls: Array<{ conversationId: string; trigger: string }> = [];
mock.module("../memory-retrospective-enqueue.js", () => ({
  enqueueMemoryRetrospectiveIfEnabled: (args: {
    conversationId: string;
    trigger: string;
  }) => {
    enqueueCalls.push(args);
  },
}));

import type { AssistantConfig } from "../../../../config/types.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import { getDb } from "../../../../persistence/db-connection.js";
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
  db.run(`DELETE FROM memory_retrospective_state`);
  db.run(`DELETE FROM conversations`);
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

function makeConfig(
  overrides: Partial<typeof THRESHOLDS> = {},
): AssistantConfig {
  return {
    memory: {
      retrospective: { ...THRESHOLDS, ...overrides },
    },
  } as unknown as AssistantConfig;
}

describe("maybeEnqueueRetrospective — kind-aware accounting", () => {
  beforeEach(() => {
    resetTables();
    enqueueCalls = [];
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
