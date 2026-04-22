/**
 * End-to-end test for the auto-analysis trigger path:
 *
 *   indexMessageNow()        →  enqueueAutoAnalysisIfEnabled()
 *                            →  conversation_analyze job in memory_jobs
 *   conversationAnalyzeJob() →  analyzeConversation() invoked with trigger=auto
 *                            →  rolling analysis conversation persisted
 *
 * Exercises the indexer-level enqueue wiring added in PR 14 alongside the
 * helper from PR 12 and the job handler from PR 13. The real
 * `analyzeConversation()` agent loop is mocked so the test doesn't make
 * live LLM calls; everything else (DB writes, feature-flag resolution,
 * recursion guard, job row shape) runs against the real code.
 *
 * We feed the job directly to `conversationAnalyzeJob()` rather than
 * invoking the full `runMemoryJobsOnce()` drain — the worker's per-tick
 * dispatch would also claim embed_segment and graph_extract jobs whose
 * real backends would time out in this test context.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { and, eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

// ── Logger / external-IO mocks ─────────────────────────────────────
// Must precede any imports that pull transitive deps.

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// ── Test config ────────────────────────────────────────────────────
// Low batch size on both `memory.extraction.batchSize` and
// `analysis.batchSize` so a small handful of indexer calls trips the
// batch trigger inside indexer.ts.

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: true,
      batchSize: 3,
      idleTimeoutMs: 300_000,
    },
  },
  analysis: {
    ...DEFAULT_CONFIG.analysis,
    batchSize: 3,
    idleTimeoutMs: 600_000,
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Stub the analyze-conversation service ──────────────────────────
// The real service kicks off an agent loop against a provider. We only
// care about confirming dispatch (conversationId + trigger) and that a
// child analysis conversation row gets created with the right
// source/forkParent linkage.
//
// To produce the child conversation in the "auto" path, the stub
// directly calls the existing conversation-crud helper with the same
// fields the real service uses. This keeps the DB shape realistic so
// downstream assertions (source, forkParentConversationId) are exercised
// against real rows — not against mock return values.

type AnalyzeCall = {
  conversationId: string;
  opts: { trigger: "manual" | "auto" };
};
const analyzeCalls: AnalyzeCall[] = [];

mock.module("../runtime/services/analyze-conversation.js", () => ({
  analyzeConversation: async (
    conversationId: string,
    _deps: unknown,
    opts: { trigger: "manual" | "auto" },
  ): Promise<{ analysisConversationId: string }> => {
    analyzeCalls.push({ conversationId, opts });

    // Mirror the auto-path behavior: create a rolling analysis
    // conversation with source="auto-analysis" and
    // forkParentConversationId set to the source.
    const { createConversation, findAnalysisConversationFor } = await import(
      "../memory/conversation-crud.js"
    );
    const existing = findAnalysisConversationFor(conversationId);
    if (existing) {
      return { analysisConversationId: existing.id };
    }
    const conv = createConversation({
      title: `Analysis: src-${conversationId}`,
      source: "auto-analysis",
      forkParentConversationId: conversationId,
    });
    return { analysisConversationId: conv.id };
  },
}));

// Stub the deps singleton so the job handler doesn't return early due to
// "Analysis deps not yet initialized" — the stub above doesn't actually
// touch the deps bundle, so any non-null shape suffices.
mock.module("../runtime/services/analyze-deps-singleton.js", () => ({
  getAnalysisDeps: () => ({ _tag: "test-deps" }),
  setAnalysisDeps: () => {},
}));

// ── Real imports ──────────────────────────────────────────────────

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import { conversationAnalyzeJob } from "../memory/conversation-analyze-job.js";
import { createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { indexMessageNow } from "../memory/indexer.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import { conversations, memoryJobs, messages } from "../memory/schema.js";

// ── Helpers ───────────────────────────────────────────────────────

/** Long enough to survive MIN_SEGMENT_CHARS (50) in the indexer. */
function longEnoughText(suffix: string): string {
  return (
    "This is a reasonably long message body with enough content to survive" +
    " the minimum segment-length threshold in the memory indexer." +
    ` Suffix: ${suffix}`
  );
}

/** Reset mutable tables that tests touch, preserving schema. */
function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM memory_checkpoints");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_graph_nodes");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_jobs");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Insert a raw message row, bypassing the async addMessage helper. */
function seedMessage(
  conversationId: string,
  messageId: string,
  text: string,
  now: number,
): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id: messageId,
      conversationId,
      role: "user",
      content: JSON.stringify([{ type: "text", text }]),
      createdAt: now,
    })
    .run();
}

async function indexMessages(
  conversationId: string,
  count: number,
  offset = 0,
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const idx = offset + i;
    const messageId = `${conversationId}-msg-${idx}`;
    const text = longEnoughText(`${conversationId}-${idx}`);
    seedMessage(conversationId, messageId, text, now + idx);
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: now + idx,
      },
      TEST_CONFIG.memory,
    );
  }
}

function countJobsOfType(
  type: string,
  conversationId?: string,
): number {
  const db = getDb();
  const rows = db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all();
  if (conversationId == null) return rows.length;
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload) as { conversationId?: string };
      return payload.conversationId === conversationId;
    } catch {
      return false;
    }
  }).length;
}

/**
 * Pull a pending `conversation_analyze` job for the given conversation
 * straight out of the DB and feed it to the job handler. This exercises
 * the worker's dispatch path (jobs-worker.ts → processJob → case
 * "conversation_analyze" → conversationAnalyzeJob) without pulling in
 * the full `runMemoryJobsOnce()` side effects (embed backends, circuit
 * breakers, cleanup scheduling).
 */
async function drainOneConversationAnalyzeJob(
  conversationId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "conversation_analyze"))
    .all();
  const target = rows.find((row) => {
    try {
      const payload = JSON.parse(row.payload) as { conversationId?: string };
      return payload.conversationId === conversationId;
    } catch {
      return false;
    }
  });
  if (!target) return false;
  const parsedPayload = JSON.parse(target.payload) as {
    conversationId?: string;
  };
  const job: MemoryJob<{ conversationId?: string }> = {
    id: target.id,
    type: "conversation_analyze",
    payload: parsedPayload,
    status: "running",
    attempts: target.attempts,
    deferrals: target.deferrals,
    runAfter: target.runAfter,
    lastError: target.lastError,
    startedAt: target.startedAt,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
  await conversationAnalyzeJob(job, TEST_CONFIG);
  return true;
}

// ── Test fixture ──────────────────────────────────────────────────

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  resetTables();
  analyzeCalls.length = 0;
  // Clear any stale feature-flag overrides between tests.
  _setOverridesForTesting({});
});

// ─────────────────────────────────────────────────────────────────

describe("auto-analysis end-to-end trigger path", () => {
  test("flag on, batch threshold reached → conversation_analyze enqueued, handler runs, analysis conversation created", async () => {
    _setOverridesForTesting({ "auto-analyze": true });

    const source = createConversation("source-conv");

    // batchSize = 3 → third index call trips the batch trigger in indexer.ts
    await indexMessages(source.id, 3);

    // A conversation_analyze job for this source should now be pending.
    const enqueuedBefore = countJobsOfType("conversation_analyze", source.id);
    expect(enqueuedBefore).toBeGreaterThanOrEqual(1);

    // Feed the pending job to the handler. This mirrors how the worker
    // dispatches it, without triggering the full drain loop (which would
    // also try to process embed_segment / graph_extract jobs that fail
    // against real embedding backends in tests).
    const drained = await drainOneConversationAnalyzeJob(source.id);
    expect(drained).toBe(true);

    // The stubbed analyzeConversation must have been called with the
    // source conversation id and trigger=auto.
    const autoCallsForSource = analyzeCalls.filter(
      (c) => c.conversationId === source.id && c.opts.trigger === "auto",
    );
    expect(autoCallsForSource.length).toBeGreaterThanOrEqual(1);

    // A rolling analysis conversation should exist with
    // source="auto-analysis" and forkParentConversationId matching the
    // source id (created by the analyzeConversation stub).
    const db = getDb();
    const analysisRows = db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.source, "auto-analysis"),
          eq(conversations.forkParentConversationId, source.id),
        ),
      )
      .all();
    expect(analysisRows.length).toBe(1);
  });

  test("flag off → no conversation_analyze job is ever enqueued", async () => {
    _setOverridesForTesting({ "auto-analyze": false });

    const source = createConversation("source-conv-flag-off");
    await indexMessages(source.id, 3);

    expect(countJobsOfType("conversation_analyze", source.id)).toBe(0);
    // The stub should never have been invoked for this source since no
    // job was ever enqueued.
    expect(
      analyzeCalls.filter((c) => c.conversationId === source.id),
    ).toHaveLength(0);
  });

  test("recursion guard: indexing into an auto-analysis conversation does not enqueue conversation_analyze or graph_extract", async () => {
    _setOverridesForTesting({ "auto-analyze": true });

    // Set up an auto-analysis conversation directly. This is the
    // scenario we need to protect against — the analysis agent writes
    // messages into its own conversation, the indexer picks them up,
    // and without the guard it would enqueue a recursive
    // conversation_analyze job.
    const parent = createConversation("recursion-parent");
    const analysisConv = createConversation({
      title: "Analysis: recursion-parent",
      source: "auto-analysis",
      forkParentConversationId: parent.id,
    });

    // batchSize = 3 → without the recursion guard, this WOULD trip the
    // batch trigger and enqueue both graph_extract and
    // conversation_analyze jobs for analysisConv.
    await indexMessages(analysisConv.id, 3);

    // Neither conversation_analyze nor graph_extract should be enqueued
    // for an auto-analysis conversation. The analysis agent writes
    // memory directly via tools, so extracting from its reflective
    // musings double-counts, and analyzing its own output would loop
    // indefinitely. The recursion guard in indexer.ts skips the whole
    // graph_extract + enqueueAutoAnalysisIfEnabled path for
    // auto-analysis sources (summaries are still produced — they feed
    // retrieval and aren't recursion-prone).
    expect(countJobsOfType("conversation_analyze", analysisConv.id)).toBe(0);
    expect(countJobsOfType("graph_extract", analysisConv.id)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Independent cadence: analysis.batchSize gates the auto-analysis
// batch trigger separately from extraction.batchSize, ensuring
// analysis fires at its own cadence (default 30) rather than at the
// extraction cadence (default 10).
// ─────────────────────────────────────────────────────────────────

describe("auto-analysis batch trigger uses analysis.batchSize cadence", () => {
  // Mutate the shared TEST_CONFIG batch sizes for this block. The
  // mocked `getConfig()` returns the same reference, so changes are
  // observed by the indexer immediately.
  const originalExtractionBatch = TEST_CONFIG.memory.extraction.batchSize;
  const originalAnalysisBatch = TEST_CONFIG.analysis.batchSize;

  beforeEach(() => {
    _setOverridesForTesting({ "auto-analyze": true });
    TEST_CONFIG.memory.extraction.batchSize = 2;
    TEST_CONFIG.analysis.batchSize = 5;
  });

  afterEach(() => {
    TEST_CONFIG.memory.extraction.batchSize = originalExtractionBatch;
    TEST_CONFIG.analysis.batchSize = originalAnalysisBatch;
  });

  test("4 messages: extraction trips twice, analysis stays below threshold (0 jobs)", async () => {
    const source = createConversation("cadence-source-4");
    await indexMessages(source.id, 4);

    // Extraction batch (size 2) is crossed at messages 2 and 4 → at
    // least one graph_extract job should exist for this conversation.
    // (The exact count depends on whether the per-message
    // upsertDebouncedJob coalesced them with the immediate enqueues.)
    expect(countJobsOfType("graph_extract", source.id)).toBeGreaterThanOrEqual(
      1,
    );

    // Analysis batch (size 5) is NOT crossed by 4 messages → zero
    // batch-triggered analysis jobs. The idle-debounced enqueue
    // upserts a single far-future row; that's not a duplicate.
    expect(countJobsOfType("conversation_analyze", source.id)).toBeLessThanOrEqual(
      1,
    );

    // Stronger: any pending analysis job must be debounced (runAfter
    // far in the future), not the immediate batch fire.
    const db = getDb();
    const analysisRows = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "conversation_analyze"))
      .all()
      .filter((row) => {
        try {
          const payload = JSON.parse(row.payload) as {
            conversationId?: string;
          };
          return payload.conversationId === source.id;
        } catch {
          return false;
        }
      });
    for (const row of analysisRows) {
      // idleTimeoutMs = 600_000 → all rows here should be debounced
      // (runAfter ≫ now). Allow a small clock-skew margin.
      expect(row.runAfter).toBeGreaterThan(Date.now() + 60_000);
    }
  });

  test("5th message crosses analysis.batchSize → conversation_analyze enqueued for immediate run", async () => {
    const source = createConversation("cadence-source-5");

    // First 4 messages: analysis batch threshold not yet reached.
    await indexMessages(source.id, 4);

    // Fifth message: crosses analysis.batchSize=5 → batch-triggered
    // upsert should produce a row whose runAfter is roughly "now"
    // (the immediate-fire path), not pushed into the future by the
    // idle debounce.
    const before = Date.now();
    await indexMessages(source.id, 1, 4);
    const after = Date.now();

    const db = getDb();
    const analysisRows = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "conversation_analyze"))
      .all()
      .filter((row) => {
        try {
          const payload = JSON.parse(row.payload) as {
            conversationId?: string;
          };
          return payload.conversationId === source.id;
        } catch {
          return false;
        }
      });

    // Two rows — the batch trigger writes an "immediate" triggerGroup
    // row, while the per-message idle upserts write/update a separate
    // "debounced" triggerGroup row. Keeping them distinct prevents an
    // idle enqueue from pushing the batch-triggered runAfter forward.
    expect(analysisRows.length).toBe(2);

    const withGroup = analysisRows.map((row) => {
      const payload = JSON.parse(row.payload) as {
        triggerGroup?: "immediate" | "debounced";
      };
      return { row, triggerGroup: payload.triggerGroup };
    });
    const immediate = withGroup.find((r) => r.triggerGroup === "immediate");
    const debounced = withGroup.find((r) => r.triggerGroup === "debounced");
    expect(immediate).toBeDefined();
    expect(debounced).toBeDefined();

    // Immediate row (batch trigger) has runAfter ≈ now — allow a 1s
    // margin on either side for clock skew.
    expect(immediate!.row.runAfter).toBeGreaterThanOrEqual(before - 1_000);
    expect(immediate!.row.runAfter).toBeLessThanOrEqual(after + 1_000);

    // Debounced row (per-message idle) is pushed far into the future
    // and is not affected by the immediate batch enqueue.
    expect(debounced!.row.runAfter).toBeGreaterThan(Date.now() + 60_000);
  });

  test("crossing extraction.batchSize → graph_extract pending row has immediate runAfter", async () => {
    const source = createConversation("cadence-source-graph");

    // extraction.batchSize = 2 → second message trips the batch
    // trigger. The batch enqueue runs last and pulls `runAfter` back
    // to `Date.now()`, overriding the per-message idle debounce. The
    // single coalesced pending row should end up at ~now.
    await indexMessages(source.id, 1);
    const before = Date.now();
    await indexMessages(source.id, 1, 1);
    const after = Date.now();

    const db = getDb();
    const graphRows = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all()
      .filter((row) => {
        try {
          const payload = JSON.parse(row.payload) as {
            conversationId?: string;
          };
          return payload.conversationId === source.id;
        } catch {
          return false;
        }
      });

    expect(graphRows.length).toBe(1);
    const row = graphRows[0]!;
    expect(row.runAfter).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.runAfter).toBeLessThanOrEqual(after + 1_000);
  });
});
