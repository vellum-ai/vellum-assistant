import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "memory-regressions-exp-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";

// Disable LLM extraction in tests to avoid real API calls and ensure
// deterministic pattern-based extraction.
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { indexMessageNow } from "../memory/indexer.js";
import { vectorToBlob } from "../memory/job-utils.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import {
  resetCleanupScheduleThrottle,
  resetStaleSweepThrottle,
  runMemoryJobsOnce,
} from "../memory/jobs-worker.js";
import { buildMemoryRecall } from "../memory/retriever.js";
import {
  conversations,
  memoryEmbeddings,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  memorySummaries,
  messages,
} from "../memory/schema.js";

describe("Memory regressions (experimental)", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_conflicts");
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_summaries");
    db.run("DELETE FROM memory_items");

    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM memory_checkpoints");
    resetCleanupScheduleThrottle();
    resetStaleSweepThrottle();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  async function withMockOllamaQueryEmbedding<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function semanticRecallConfig() {
    return {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "ollama" as const,
          required: true,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          lexicalTopK: 0,
          semanticTopK: 10,
          maxInjectTokens: 2000,
        },
      },
    };
  }

  test("semantic recall excludes items backed only by excluded message ids", async () => {
    const db = getDb();
    const now = 1_700_000_120_000;
    db.insert(conversations)
      .values({
        id: "conv-semantic-exclude",
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values([
        {
          id: "msg-semantic-old",
          conversationId: "conv-semantic-exclude",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "Timezone is PST." }]),
          createdAt: now - 10_000,
        },
        {
          id: "msg-semantic-current",
          conversationId: "conv-semantic-exclude",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Remember timezone PST for this turn." },
          ]),
          createdAt: now,
        },
      ])
      .run();
    db.insert(memoryItems)
      .values([
        {
          id: "item-semantic-old",
          kind: "fact",
          subject: "timezone",
          statement: "User timezone is PST",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-old-fingerprint",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
          lastUsedAt: null,
        },
        {
          id: "item-semantic-current",
          kind: "fact",
          subject: "timezone",
          statement: "User timezone is PST (current turn)",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-current-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
      ])
      .run();
    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-semantic-old",
          messageId: "msg-semantic-old",
          evidence: "old source",
          createdAt: now - 10_000,
        },
        {
          memoryItemId: "item-semantic-current",
          messageId: "msg-semantic-current",
          evidence: "current turn source",
          createdAt: now,
        },
      ])
      .run();
    db.insert(memoryEmbeddings)
      .values([
        {
          id: "emb-semantic-old",
          targetType: "item",
          targetId: "item-semantic-old",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "emb-semantic-current",
          targetType: "item",
          targetId: "item-semantic-current",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const recall = await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall(
        "timezone",
        "conv-semantic-exclude",
        semanticRecallConfig(),
        { excludeMessageIds: ["msg-semantic-current"] },
      ),
    );
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain("User timezone is PST");
    expect(recall.injectedText).not.toContain("(current turn)");
  });

  test("semantic recall skips active items that have no remaining evidence rows", async () => {
    const db = getDb();
    const now = 1_700_000_130_000;
    db.insert(conversations)
      .values({
        id: "conv-semantic-evidence",
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-semantic-evidence",
        conversationId: "conv-semantic-evidence",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Timezone is PST." }]),
        createdAt: now,
      })
      .run();
    db.insert(memoryItems)
      .values([
        {
          id: "item-semantic-with-evidence",
          kind: "fact",
          subject: "timezone",
          statement: "User timezone is PST",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-with-evidence-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
        {
          id: "item-semantic-orphan",
          kind: "fact",
          subject: "timezone",
          statement: "Stale orphan fact",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-orphan-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
      ])
      .run();
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-semantic-with-evidence",
        messageId: "msg-semantic-evidence",
        evidence: "message evidence",
        createdAt: now,
      })
      .run();
    db.insert(memoryEmbeddings)
      .values([
        {
          id: "emb-semantic-with-evidence",
          targetType: "item",
          targetId: "item-semantic-with-evidence",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "emb-semantic-orphan",
          targetType: "item",
          targetId: "item-semantic-orphan",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const recall = await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall(
        "timezone",
        "conv-semantic-evidence",
        semanticRecallConfig(),
      ),
    );
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain("User timezone is PST");
    expect(recall.injectedText).not.toContain("Stale orphan fact");
  });

  test("semantic recall excludes conversation summaries that overlap excluded messages", async () => {
    const db = getDb();
    const now = 1_700_000_140_000;
    const conversationId = "conv-semantic-summary";
    db.insert(conversations)
      .values({
        id: conversationId,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-semantic-summary-excluded",
        conversationId,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "This is the current turn message." },
        ]),
        createdAt: now,
      })
      .run();
    db.insert(memorySummaries)
      .values([
        {
          id: "summary-semantic-conversation",
          scope: "conversation",
          scopeKey: conversationId,
          summary: "Conversation summary containing current turn details",
          tokenEstimate: 12,
          startAt: now - 500,
          endAt: now + 500,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "summary-semantic-weekly",
          scope: "weekly_global",
          scopeKey: "2026-W07",
          summary: "Weekly summary that should remain eligible",
          tokenEstimate: 12,
          startAt: now - 10_000,
          endAt: now + 10_000,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(memoryEmbeddings)
      .values([
        {
          id: "emb-summary-semantic-conversation",
          targetType: "summary",
          targetId: "summary-semantic-conversation",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "emb-summary-semantic-weekly",
          targetType: "summary",
          targetId: "summary-semantic-weekly",
          provider: "ollama",
          model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
          dimensions: 3,
          vectorBlob: vectorToBlob([1, 0, 0]),
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const recall = await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall("summary", conversationId, semanticRecallConfig(), {
        excludeMessageIds: ["msg-semantic-summary-excluded"],
      }),
    );
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).not.toContain(
      "Conversation summary containing current turn details",
    );
    expect(recall.injectedText).toContain(
      "Weekly summary that should remain eligible",
    );
  });

  test("indexing no longer enqueues segment embedding jobs", () => {
    const db = getDb();
    const createdAt = 2_000;
    db.insert(conversations)
      .values({
        id: "conv-index",
        title: null,
        createdAt,
        updatedAt: createdAt,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-index",
        conversationId: "conv-index",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Please remember this implementation detail." },
        ]),
        createdAt,
      })
      .run();

    const result = indexMessageNow(
      {
        messageId: "msg-index",
        conversationId: "conv-index",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Please remember this implementation detail." },
        ]),
        createdAt,
      },
      DEFAULT_CONFIG.memory,
    );
    expect(result.enqueuedJobs).toBe(2);

    const embedSegmentJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_segment"))
      .all();
    expect(embedSegmentJobs).toHaveLength(0);
  });

  test("indexing skips durable item extraction for assistant messages when extractFromAssistant is false", () => {
    const db = getDb();
    const createdAt = 2_100;
    db.insert(conversations)
      .values({
        id: "conv-assistant-index",
        title: null,
        createdAt,
        updatedAt: createdAt,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-assistant-index",
        conversationId: "conv-assistant-index",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "I think your timezone is PST." },
        ]),
        createdAt,
      })
      .run();

    const memoryConfig = {
      ...DEFAULT_CONFIG.memory,
      extraction: {
        ...DEFAULT_CONFIG.memory.extraction,
        extractFromAssistant: false,
      },
    };

    const result = indexMessageNow(
      {
        messageId: "msg-assistant-index",
        conversationId: "conv-assistant-index",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "I think your timezone is PST." },
        ]),
        createdAt,
      },
      memoryConfig,
    );
    expect(result.enqueuedJobs).toBe(1);

    const extractionJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();
    expect(extractionJobs).toHaveLength(0);
  });

  test("embed jobs are skipped (not failed) when no embedding backend is configured", async () => {
    const db = getDb();
    const now = 3_000;
    db.insert(memoryItems)
      .values({
        id: "item-no-backend",
        kind: "fact",
        subject: "backend",
        statement: "No embedding backend configured in test",
        status: "active",
        confidence: 0.8,
        fingerprint: "item-no-backend-fingerprint",
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();
    const jobId = enqueueMemoryJob("embed_item", { itemId: "item-no-backend" });

    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    const row = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .get();
    expect(row?.status).toBe("completed");
  });
});
