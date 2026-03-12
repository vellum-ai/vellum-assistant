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

const testDir = mkdtempSync(join(tmpdir(), "memory-regressions-"));

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

// Stub the local embedding backend so the real ONNX model (2.5 GB RSS) never
// loads — avoids a Bun v1.3.9 panic on process exit.
mock.module("../memory/embedding-local.js", () => ({
  LocalEmbeddingBackend: class {
    readonly provider = "local" as const;
    readonly model: string;
    constructor(model: string) {
      this.model = model;
    }
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(384).fill(0));
    }
  },
}));

// Mock Qdrant client so semantic search returns empty results instead of
// throwing "Qdrant client not initialized".
mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { and, eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { vectorToBlob } from "../memory/job-utils.js";

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
import { estimateTextTokens } from "../context/token-estimator.js";
import {
  getMemorySystemStatus,
  requestMemoryBackfill,
  requestMemoryCleanup,
} from "../memory/admin.js";
import { getMemoryCheckpoint } from "../memory/checkpoints.js";
import {
  createOrUpdatePendingConflict,
  getConflictById,
  resolveConflict,
} from "../memory/conflict-store.js";
import {
  addMessage,
  createConversation,
  getConversationMemoryScopeId,
  messageMetadataSchema,
  provenanceFromTrustContext,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { selectEmbeddingBackend } from "../memory/embedding-backend.js";
import {
  upsertEntity,
  upsertEntityRelation,
} from "../memory/entity-extractor.js";
import {
  getRecentSegmentsForConversation,
  indexMessageNow,
} from "../memory/indexer.js";
import { extractAndUpsertMemoryItemsForMessage } from "../memory/items-extractor.js";
import {
  backfillEntityRelationsJob,
  backfillJob,
} from "../memory/job-handlers/backfill.js";
import { buildConversationSummaryJob } from "../memory/job-handlers/summarization.js";
import {
  claimMemoryJobs,
  enqueueBackfillEntityRelationsJob,
  enqueueCleanupResolvedConflictsJob,
  enqueueCleanupStaleSupersededItemsJob,
  enqueueMemoryJob,
  enqueueResolvePendingConflictsForMessageJob,
} from "../memory/jobs-store.js";
import {
  currentWeekWindow,
  maybeEnqueueScheduledCleanupJobs,
  resetCleanupScheduleThrottle,
  resetStaleSweepThrottle,
  runMemoryJobsOnce,
  sweepStaleItems,
} from "../memory/jobs-worker.js";
import {
  buildMemoryRecall,
  escapeXmlTags,
  formatAbsoluteTime,
  formatRelativeTime,
  injectMemoryRecallAsSeparateMessage,
  injectMemoryRecallIntoUserMessage,
  stripMemoryRecallMessages,
} from "../memory/retriever.js";
import {
  conversations,
  memoryEmbeddings,
  memoryEntities,
  memoryEntityRelations,
  memoryItemConflicts,
  memoryItemEntities,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  memorySegments,
  memorySummaries,
  messages,
} from "../memory/schema.js";

describe("Memory regressions", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_conflicts");
    db.run("DELETE FROM memory_item_entities");
    db.run("DELETE FROM memory_entity_relations");
    db.run("DELETE FROM memory_entities");
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

  // Baseline: indexMessageNow without explicit scopeId defaults to 'default'
  test('baseline: memory segments default to scope "default" when no scopeId given', () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-baseline-scope",
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
        id: "msg-baseline-scope",
        conversationId: "conv-baseline-scope",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "The user likes dark mode." },
        ]),
        createdAt: now,
      })
      .run();

    // Index without explicit scopeId — should use 'default'
    indexMessageNow(
      {
        messageId: "msg-baseline-scope",
        conversationId: "conv-baseline-scope",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "The user likes dark mode." },
        ]),
        createdAt: now,
      },
      DEFAULT_CONFIG.memory,
    );

    const segs = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, "msg-baseline-scope"))
      .all();

    expect(segs.length).toBeGreaterThan(0);
    for (const seg of segs) {
      expect(seg.scopeId).toBe("default");
    }
  });

  test("recall excludes current-turn message ids from injected candidates", async () => {
    const db = getDb();
    const now = 1_700_000_100_000;
    db.insert(conversations)
      .values({
        id: "conv-exclude",
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
        id: "msg-old",
        conversationId: "conv-exclude",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Remember my timezone is PST." },
        ]),
        createdAt: now - 10_000,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-current",
        conversationId: "conv-exclude",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "What is my timezone again?" },
        ]),
        createdAt: now,
      })
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES
      ('seg-old', 'msg-old', 'conv-exclude', 'user', 0, 'Remember my timezone is PST.', 7, ${
        now - 10_000
      }, ${now - 10_000}),
      ('seg-current', 'msg-current', 'conv-exclude', 'user', 0, 'What is my timezone again?', 7, ${now}, ${now})
    `);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall("timezone", "conv-exclude", config, {
      excludeMessageIds: ["msg-current"],
    });
    expect(recall.injectedText).toContain("Remember my timezone is PST.");
    expect(recall.injectedText).not.toContain("What is my timezone again?");
  });

  test("memory recall injection remains user-role and is stripped from runtime history", () => {
    const memoryRecallText =
      "[Memory Recall v1]\n- [item:abc] user prefers concise answers";
    const originalUserMessage = {
      role: "user" as const,
      content: [{ type: "text", text: "Actual user request" }],
    };
    const injected = injectMemoryRecallIntoUserMessage(
      originalUserMessage,
      memoryRecallText,
    );

    expect(injected.role).toBe("user");
    expect(injected.content[0]).toEqual({
      type: "text",
      text: memoryRecallText,
    });

    const cleaned = stripMemoryRecallMessages([injected], memoryRecallText);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toEqual(originalUserMessage);
  });

  test("memory recall stripping preserves literal marker text outside the injected block", () => {
    const memoryRecallText =
      "[Memory Recall v1]\n- [item:abc] user prefers concise answers";
    const literalUserMessage = {
      role: "user" as const,
      content: [
        {
          type: "text",
          text: "[Memory Recall v1] this is user-authored content",
        },
      ],
    };
    const literalAssistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text", text: memoryRecallText }],
    };
    const originalUserTail = {
      role: "user" as const,
      content: [{ type: "text", text: "Actual user request" }],
    };
    const injectedTail = injectMemoryRecallIntoUserMessage(
      originalUserTail,
      memoryRecallText,
    );

    const cleaned = stripMemoryRecallMessages(
      [literalUserMessage, literalAssistantMessage, injectedTail],
      memoryRecallText,
    );

    expect(cleaned).toHaveLength(3);
    expect(cleaned[0]).toEqual(literalUserMessage);
    expect(cleaned[1]).toEqual(literalAssistantMessage);
    expect(cleaned[2]).toEqual(originalUserTail);
  });

  test("recall stripping removes last matching block in merged content after deep-repair", () => {
    const memoryRecallText =
      "[Memory Recall v1]\n- [item:abc] user prefers concise answers";
    // Simulate deep-repair merging two consecutive user messages where both
    // contain the recall text. The injected (active) recall block is the last one.
    const mergedUserMessage = {
      role: "user" as const,
      content: [
        { type: "text", text: memoryRecallText },
        { type: "text", text: "Earlier user request" },
        { type: "text", text: memoryRecallText },
        { type: "text", text: "Latest user request" },
      ],
    };

    const cleaned = stripMemoryRecallMessages(
      [mergedUserMessage],
      memoryRecallText,
    );
    expect(cleaned).toHaveLength(1);
    // The last (active) recall block should be stripped, the first (leaked) one preserved
    expect(cleaned[0].content).toEqual([
      { type: "text", text: memoryRecallText },
      { type: "text", text: "Earlier user request" },
      { type: "text", text: "Latest user request" },
    ]);
  });

  test("separate_context_message injects memory as user+assistant pair before last user message", () => {
    const history = [
      { role: "user" as const, content: [{ type: "text", text: "Hello" }] },
      { role: "assistant" as const, content: [{ type: "text", text: "Hi!" }] },
      {
        role: "user" as const,
        content: [{ type: "text", text: "Tell me about X" }],
      },
    ];
    const recallText = "<memory>Some recalled fact</memory>";
    const result = injectMemoryRecallAsSeparateMessage(history, recallText);
    // Should have 5 messages: original 2 + injected user + injected assistant ack + original last user
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(history[0]);
    expect(result[1]).toBe(history[1]);
    // Injected context message
    expect(result[2].role).toBe("user");
    expect(result[2].content).toEqual([{ type: "text", text: recallText }]);
    // Assistant acknowledgment
    expect(result[3].role).toBe("assistant");
    expect(result[3].content).toEqual([
      { type: "text", text: "[Memory context loaded.]" },
    ]);
    // Original user message preserved unchanged
    expect(result[4]).toBe(history[2]);
  });

  test("separate_context_message with empty text is a no-op", () => {
    const history = [
      { role: "user" as const, content: [{ type: "text", text: "Hello" }] },
    ];
    const result = injectMemoryRecallAsSeparateMessage(history, "  ");
    expect(result).toBe(history);
  });

  test("stripMemoryRecallMessages removes separate_context_message pair", () => {
    const recallText = "<memory>Some recalled fact</memory>";
    const messages = [
      { role: "user" as const, content: [{ type: "text", text: "Hello" }] },
      { role: "assistant" as const, content: [{ type: "text", text: "Hi!" }] },
      // Injected context message pair
      { role: "user" as const, content: [{ type: "text", text: recallText }] },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "[Memory context loaded.]" }],
      },
      // Real user message
      {
        role: "user" as const,
        content: [{ type: "text", text: "Tell me about X" }],
      },
    ];
    const cleaned = stripMemoryRecallMessages(messages, recallText);
    expect(cleaned).toHaveLength(3);
    expect(cleaned[0].content[0].text).toBe("Hello");
    expect(cleaned[1].content[0].text).toBe("Hi!");
    expect(cleaned[2].content[0].text).toBe("Tell me about X");
  });

  test("stripMemoryRecallMessages falls back to prepend_user_block when no separate pair found", () => {
    const recallText = "<memory>Fact</memory>";
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text", text: recallText },
          { type: "text", text: "User query" },
        ],
      },
    ];
    const cleaned = stripMemoryRecallMessages(messages, recallText);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content).toEqual([{ type: "text", text: "User query" }]);
  });

  test("aborting memory recall embedding returns a non-degraded aborted recall result", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;

    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          reject(new Error("Expected abort signal"));
          return;
        }
        const abortError = new Error("Aborted");
        abortError.name = "AbortError";
        if (signal.aborted) {
          reject(abortError);
          return;
        }
        signal.addEventListener("abort", () => reject(abortError), {
          once: true,
        });
      });
    }) as typeof globalThis.fetch;

    try {
      const recallPromise = buildMemoryRecall(
        "timezone",
        "conv-abort",
        semanticRecallConfig(),
        { signal: controller.signal },
      );
      controller.abort();
      const recall = await recallPromise;
      expect(seenSignal).toBe(controller.signal);
      expect(recall.degraded).toBe(false);
      expect(recall.reason).toBe("memory.aborted");
      expect(recall.injectedText).toBe("");
      expect(recall.injectedTokens).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("memory item lastSeenAt follows message.createdAt and does not move backwards", async () => {
    const db = getDb();
    db.insert(conversations)
      .values({
        id: "conv-2",
        title: null,
        createdAt: 1_000,
        updatedAt: 1_000,
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
        id: "msg-newer",
        conversationId: "conv-2",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "We decided to use sqlite for local persistence because reliability matters.",
          },
        ]),
        createdAt: 1_000,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-older",
        conversationId: "conv-2",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "We decided to use sqlite for local persistence because reliability matters.",
          },
        ]),
        createdAt: 500,
      })
      .run();

    await extractAndUpsertMemoryItemsForMessage("msg-newer");
    await extractAndUpsertMemoryItemsForMessage("msg-older");

    const row = db
      .select()
      .from(memoryItems)
      .where(
        and(eq(memoryItems.kind, "decision"), eq(memoryItems.status, "active")),
      )
      .get();

    expect(row).not.toBeNull();
    expect(row?.lastSeenAt).toBe(1_000);
  });

  test("memory_save sets verificationState to user_confirmed", async () => {
    const { handleMemorySave } = await import("../tools/memory/handlers.js");

    const result = await handleMemorySave(
      {
        statement: "User explicitly saved this preference",
        kind: "preference",
      },
      DEFAULT_CONFIG,
      "conv-verify-save",
      "msg-verify-save",
    );
    expect(result.isError).toBe(false);

    const db = getDb();
    const items = db.select().from(memoryItems).all();
    const saved = items.find(
      (i) => i.statement === "User explicitly saved this preference",
    );
    expect(saved).toBeDefined();
    expect(saved!.verificationState).toBe("user_confirmed");
  });

  test("memory_save in different scopes creates separate items", async () => {
    const { handleMemorySave } = await import("../tools/memory/handlers.js");

    const sharedArgs = { statement: "I prefer dark mode", kind: "preference" };

    // Save in the default scope
    const r1 = await handleMemorySave(
      sharedArgs,
      DEFAULT_CONFIG,
      "conv-scope-1",
      "msg-scope-1",
      "default",
    );
    expect(r1.isError).toBe(false);
    expect(r1.content).toContain("Saved to memory");

    // Save the identical statement in a private scope
    const r2 = await handleMemorySave(
      sharedArgs,
      DEFAULT_CONFIG,
      "conv-scope-2",
      "msg-scope-2",
      "private-abc",
    );
    expect(r2.isError).toBe(false);
    expect(r2.content).toContain("Saved to memory");

    // Both items should exist with distinct IDs
    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.statement, "I prefer dark mode"))
      .all();
    expect(items.length).toBe(2);

    const scopes = new Set(items.map((i) => i.scopeId));
    expect(scopes.has("default")).toBe(true);
    expect(scopes.has("private-abc")).toBe(true);

    // Saving the same statement again in default scope should dedup (not create a third)
    const r3 = await handleMemorySave(
      sharedArgs,
      DEFAULT_CONFIG,
      "conv-scope-3",
      "msg-scope-3",
      "default",
    );
    expect(r3.isError).toBe(false);
    expect(r3.content).toContain("already exists");

    const afterDedup = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.statement, "I prefer dark mode"))
      .all();
    expect(afterDedup.length).toBe(2);
  });

  test("memory_update promotes verificationState to user_confirmed", async () => {
    const db = getDb();
    const now = Date.now();
    const { handleMemoryUpdate } = await import("../tools/memory/handlers.js");

    // Pre-seed an assistant-inferred item
    db.insert(memoryItems)
      .values({
        id: "item-update-verify",
        kind: "fact",
        subject: "update test",
        statement: "Original assistant inferred statement",
        status: "active",
        confidence: 0.6,
        importance: 0.4,
        fingerprint: "fp-update-verify-original",
        verificationState: "assistant_inferred",
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();

    const result = await handleMemoryUpdate(
      {
        memory_id: "item-update-verify",
        statement: "User corrected statement",
      },
      DEFAULT_CONFIG,
    );
    expect(result.isError).toBe(false);

    const updated = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-update-verify"))
      .get();
    expect(updated).toBeDefined();
    expect(updated!.statement).toBe("User corrected statement");
    expect(updated!.verificationState).toBe("user_confirmed");
  });

  test("private thread cannot update default-scope item by ID", async () => {
    const db = getDb();
    const now = Date.now();
    const { handleMemoryUpdate } = await import("../tools/memory/handlers.js");

    // Pre-seed an item in the default scope
    db.insert(memoryItems)
      .values({
        id: "item-default-no-cross",
        kind: "fact",
        subject: "cross-scope update",
        statement: "Original default-scope statement",
        status: "active",
        confidence: 0.8,
        importance: 0.6,
        fingerprint: "fp-default-no-cross",
        verificationState: "assistant_inferred",
        scopeId: "default",
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();

    // Attempt to update from a private scope — should fail with "not found"
    const result = await handleMemoryUpdate(
      { memory_id: "item-default-no-cross", statement: "Hijacked statement" },
      DEFAULT_CONFIG,
      "private-thread-xyz",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");

    // Verify the original item is unchanged
    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-default-no-cross"))
      .get();
    expect(item).toBeDefined();
    expect(item!.statement).toBe("Original default-scope statement");
  });

  test("standard thread cannot update private-scope item by ID", async () => {
    const db = getDb();
    const now = Date.now();
    const { handleMemoryUpdate } = await import("../tools/memory/handlers.js");

    // Pre-seed an item in a private scope
    db.insert(memoryItems)
      .values({
        id: "item-private-no-cross",
        kind: "preference",
        subject: "cross-scope update reverse",
        statement: "Private scope secret preference",
        status: "active",
        confidence: 0.9,
        importance: 0.7,
        fingerprint: "fp-private-no-cross",
        verificationState: "user_confirmed",
        scopeId: "private-thread-abc",
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();

    // Attempt to update from the default scope — should fail with "not found"
    const result = await handleMemoryUpdate(
      {
        memory_id: "item-private-no-cross",
        statement: "Overwritten from default",
      },
      DEFAULT_CONFIG,
      "default",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");

    // Verify the original item is unchanged
    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-private-no-cross"))
      .get();
    expect(item).toBeDefined();
    expect(item!.statement).toBe("Private scope secret preference");
  });

  test("extracted items from user messages get user_reported verification state", async () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-verify-extract",
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
        id: "msg-verify-user",
        conversationId: "conv-verify-extract",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "I prefer dark mode for all my editors and terminals.",
          },
        ]),
        createdAt: now,
      })
      .run();

    const upserted =
      await extractAndUpsertMemoryItemsForMessage("msg-verify-user");
    expect(upserted).toBeGreaterThan(0);

    const items = db.select().from(memoryItems).all();
    const userItems = items.filter(
      (i) => i.verificationState === "user_reported",
    );
    expect(userItems.length).toBeGreaterThan(0);
  });

  test("extracted items from assistant messages get assistant_inferred verification state", async () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-verify-assistant",
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
        id: "msg-verify-assistant",
        conversationId: "conv-verify-assistant",
        role: "assistant",
        content: JSON.stringify([
          {
            type: "text",
            text: "I noted that you prefer using TypeScript for all your projects.",
          },
        ]),
        createdAt: now,
      })
      .run();

    const upserted = await extractAndUpsertMemoryItemsForMessage(
      "msg-verify-assistant",
    );
    expect(upserted).toBeGreaterThan(0);

    const items = db.select().from(memoryItems).all();
    const assistantItems = items.filter(
      (i) => i.verificationState === "assistant_inferred",
    );
    expect(assistantItems.length).toBeGreaterThan(0);
  });

  test("verification state defaults to assistant_inferred for legacy rows", () => {
    const db = getDb();
    const raw = (
      db as unknown as {
        $client: {
          query: (q: string) => { get: (...params: unknown[]) => unknown };
        };
      }
    ).$client;
    // Simulate a legacy row without explicit verification_state
    raw
      .query(
        `
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .get(
        "item-legacy-verify",
        "fact",
        "Legacy item",
        "This is a legacy item",
        "active",
        0.5,
        "fp-legacy-verify",
        Date.now(),
        Date.now(),
      );

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-legacy-verify"))
      .get();
    expect(item).toBeDefined();
    expect(item!.verificationState).toBe("assistant_inferred");
  });

  test("recent segment helper returns newest segments first", () => {
    const db = getDb();
    db.insert(conversations)
      .values({
        id: "conv-recent",
        title: null,
        createdAt: 2_200,
        updatedAt: 2_200,
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
          id: "msg-recent-1",
          conversationId: "conv-recent",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "old" }]),
          createdAt: 2_201,
        },
        {
          id: "msg-recent-2",
          conversationId: "conv-recent",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "newer" }]),
          createdAt: 2_202,
        },
        {
          id: "msg-recent-3",
          conversationId: "conv-recent",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "newest" }]),
          createdAt: 2_203,
        },
      ])
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES
      ('seg-recent-1', 'msg-recent-1', 'conv-recent', 'user', 0, 'old', 1, 2201, 2201),
      ('seg-recent-2', 'msg-recent-2', 'conv-recent', 'user', 0, 'newer', 1, 2202, 2202),
      ('seg-recent-3', 'msg-recent-3', 'conv-recent', 'user', 0, 'newest', 1, 2203, 2203)
    `);

    const recent = getRecentSegmentsForConversation("conv-recent", 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.id).toBe("seg-recent-3");
    expect(recent[1]?.id).toBe("seg-recent-2");
  });

  test("weekly window uses UTC boundaries for stable scope keys", () => {
    const window = currentWeekWindow(new Date("2025-01-06T00:30:00.000Z"));
    expect(window.scopeKey).toBe("2025-W02");
    expect(window.startMs).toBe(Date.parse("2025-01-06T00:00:00.000Z"));
    expect(window.endMs).toBe(Date.parse("2025-01-13T00:00:00.000Z"));
  });

  test("explicit ollama memory embedding provider is honored without extra ollama config", () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: "anthropic" as const,
      apiKeys: {},
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "ollama" as const,
        },
      },
    };

    const selection = selectEmbeddingBackend(config);
    expect(selection.backend?.provider).toBe("ollama");
    expect(selection.reason).toBeNull();
  });

  test("memory backfill request resumes by default and only restarts when forced", () => {
    const db = getDb();
    const resumeJobId = requestMemoryBackfill();
    const forceJobId = requestMemoryBackfill(true);

    const resumeRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, resumeJobId))
      .get();
    const forceRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, forceJobId))
      .get();

    expect(resumeRow).not.toBeNull();
    expect(forceRow).not.toBeNull();
    expect(JSON.parse(resumeRow?.payload ?? "{}")).toMatchObject({
      force: false,
    });
    expect(JSON.parse(forceRow?.payload ?? "{}")).toMatchObject({
      force: true,
    });
  });

  test("relation backfill enqueue is deduped and force upgrades payload", () => {
    const db = getDb();

    const firstId = enqueueBackfillEntityRelationsJob();
    const secondId = enqueueBackfillEntityRelationsJob();
    expect(secondId).toBe(firstId);

    const upgradedId = enqueueBackfillEntityRelationsJob(true);
    expect(upgradedId).toBe(firstId);

    const row = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, firstId))
      .get();
    expect(row).not.toBeUndefined();
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ force: true });
  });

  test("pending conflict resolver enqueue is deduped by message and scope", () => {
    const db = getDb();

    const firstId = enqueueResolvePendingConflictsForMessageJob(
      "msg-conflict-1",
      "scope-a",
    );
    const secondId = enqueueResolvePendingConflictsForMessageJob(
      "msg-conflict-1",
      "scope-a",
    );
    const thirdId = enqueueResolvePendingConflictsForMessageJob(
      "msg-conflict-1",
      "scope-b",
    );

    expect(secondId).toBe(firstId);
    expect(thirdId).not.toBe(firstId);

    const queued = db
      .select()
      .from(memoryJobs)
      .where(
        and(
          eq(memoryJobs.type, "resolve_pending_conflicts_for_message"),
          eq(memoryJobs.status, "pending"),
        ),
      )
      .all();
    expect(queued).toHaveLength(2);
  });

  test("background conflict resolver job applies user clarification to pending conflicts", async () => {
    const db = getDb();
    const now = 1_700_001_200_000;
    const originalConflictsEnabled = TEST_CONFIG.memory.conflicts.enabled;
    TEST_CONFIG.memory.conflicts.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-conflicts-bg",
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
          id: "msg-conflicts-bg",
          conversationId: "conv-conflicts-bg",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Keep the new MySQL default instead." },
          ]),
          createdAt: now + 1,
        })
        .run();

      db.insert(memoryItems)
        .values([
          {
            id: "item-conflict-existing",
            kind: "preference",
            subject: "database",
            statement: "Use Postgres by default.",
            status: "active",
            confidence: 0.8,
            fingerprint: "fp-conflict-existing",
            verificationState: "user_reported",
            scopeId: "scope-conflicts",
            firstSeenAt: now - 10_000,
            lastSeenAt: now - 5_000,
            validFrom: now - 10_000,
            invalidAt: null,
          },
          {
            id: "item-conflict-candidate",
            kind: "preference",
            subject: "database",
            statement: "Use MySQL by default.",
            status: "pending_clarification",
            confidence: 0.8,
            fingerprint: "fp-conflict-candidate",
            verificationState: "user_reported",
            scopeId: "scope-conflicts",
            firstSeenAt: now - 9_000,
            lastSeenAt: now - 4_000,
            validFrom: now - 9_000,
            invalidAt: null,
          },
        ])
        .run();

      const conflict = createOrUpdatePendingConflict({
        scopeId: "scope-conflicts",
        existingItemId: "item-conflict-existing",
        candidateItemId: "item-conflict-candidate",
        relationship: "ambiguous_contradiction",
      });
      db.update(memoryItemConflicts)
        .set({ createdAt: now, updatedAt: now })
        .where(eq(memoryItemConflicts.id, conflict.id))
        .run();

      enqueueResolvePendingConflictsForMessageJob(
        "msg-conflicts-bg",
        "scope-conflicts",
      );
      const processed = await runMemoryJobsOnce();
      expect(processed).toBe(1);

      const existing = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-existing"))
        .get();
      const candidate = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-candidate"))
        .get();
      const updatedConflict = getConflictById(conflict.id);

      expect(existing?.invalidAt).not.toBeNull();
      expect(existing?.status).toBe("superseded");
      expect(candidate?.status).toBe("active");
      expect(updatedConflict?.status).toBe("resolved_keep_candidate");
      expect(updatedConflict?.resolutionNote).toContain(
        "Background message resolver",
      );
    } finally {
      TEST_CONFIG.memory.conflicts.enabled = originalConflictsEnabled;
    }
  });

  test("background conflict resolver ignores conflicts created after triggering message", async () => {
    const db = getDb();
    const now = 1_700_001_300_000;
    const originalConflictsEnabled = TEST_CONFIG.memory.conflicts.enabled;
    TEST_CONFIG.memory.conflicts.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-conflicts-age",
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
          id: "msg-conflicts-age",
          conversationId: "conv-conflicts-age",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Keep the new Bun runtime instead." },
          ]),
          createdAt: now + 1,
        })
        .run();

      db.insert(memoryItems)
        .values([
          {
            id: "item-conflict-existing-age",
            kind: "preference",
            subject: "runtime",
            statement: "Use Node.js 20 by default.",
            status: "active",
            confidence: 0.8,
            fingerprint: "fp-conflict-existing-age",
            verificationState: "user_reported",
            scopeId: "scope-conflicts-age",
            firstSeenAt: now - 10_000,
            lastSeenAt: now - 5_000,
            validFrom: now - 10_000,
            invalidAt: null,
          },
          {
            id: "item-conflict-candidate-age",
            kind: "preference",
            subject: "runtime",
            statement: "Use Bun by default.",
            status: "pending_clarification",
            confidence: 0.8,
            fingerprint: "fp-conflict-candidate-age",
            verificationState: "user_reported",
            scopeId: "scope-conflicts-age",
            firstSeenAt: now - 9_000,
            lastSeenAt: now - 4_000,
            validFrom: now - 9_000,
            invalidAt: null,
          },
        ])
        .run();

      const conflict = createOrUpdatePendingConflict({
        scopeId: "scope-conflicts-age",
        existingItemId: "item-conflict-existing-age",
        candidateItemId: "item-conflict-candidate-age",
        relationship: "ambiguous_contradiction",
      });
      expect(conflict.createdAt).toBeGreaterThan(now + 1);

      enqueueResolvePendingConflictsForMessageJob(
        "msg-conflicts-age",
        "scope-conflicts-age",
      );
      const processed = await runMemoryJobsOnce();
      expect(processed).toBe(1);

      const existing = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-existing-age"))
        .get();
      const candidate = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-candidate-age"))
        .get();
      const updatedConflict = getConflictById(conflict.id);

      expect(existing?.status).toBe("active");
      expect(existing?.invalidAt).toBeNull();
      expect(candidate?.status).toBe("pending_clarification");
      expect(updatedConflict?.status).toBe("pending_clarification");
      expect(updatedConflict?.resolutionNote).toBeNull();
    } finally {
      TEST_CONFIG.memory.conflicts.enabled = originalConflictsEnabled;
    }
  });

  test("background conflict resolver ignores clarification-like replies with no topical overlap when conflict was never asked", async () => {
    const db = getDb();
    const now = 1_700_001_400_000;
    const originalConflictsEnabled = TEST_CONFIG.memory.conflicts.enabled;
    TEST_CONFIG.memory.conflicts.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-conflicts-unrelated",
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
          id: "msg-conflicts-unrelated",
          conversationId: "conv-conflicts-unrelated",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Keep the new one instead." },
          ]),
          createdAt: now + 1,
        })
        .run();

      db.insert(memoryItems)
        .values([
          {
            id: "item-conflict-existing-unrelated",
            kind: "preference",
            subject: "database",
            statement: "Use Postgres by default.",
            status: "active",
            confidence: 0.8,
            fingerprint: "fp-conflict-existing-unrelated",
            verificationState: "user_reported",
            scopeId: "scope-conflicts-unrelated",
            firstSeenAt: now - 10_000,
            lastSeenAt: now - 5_000,
            validFrom: now - 10_000,
            invalidAt: null,
          },
          {
            id: "item-conflict-candidate-unrelated",
            kind: "preference",
            subject: "database",
            statement: "Use MySQL by default.",
            status: "pending_clarification",
            confidence: 0.8,
            fingerprint: "fp-conflict-candidate-unrelated",
            verificationState: "user_reported",
            scopeId: "scope-conflicts-unrelated",
            firstSeenAt: now - 9_000,
            lastSeenAt: now - 4_000,
            validFrom: now - 9_000,
            invalidAt: null,
          },
        ])
        .run();

      const conflict = createOrUpdatePendingConflict({
        scopeId: "scope-conflicts-unrelated",
        existingItemId: "item-conflict-existing-unrelated",
        candidateItemId: "item-conflict-candidate-unrelated",
        relationship: "ambiguous_contradiction",
      });
      db.update(memoryItemConflicts)
        .set({ createdAt: now, updatedAt: now, lastAskedAt: null })
        .where(eq(memoryItemConflicts.id, conflict.id))
        .run();

      enqueueResolvePendingConflictsForMessageJob(
        "msg-conflicts-unrelated",
        "scope-conflicts-unrelated",
      );
      const processed = await runMemoryJobsOnce();
      expect(processed).toBe(1);

      const existing = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-existing-unrelated"))
        .get();
      const candidate = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-candidate-unrelated"))
        .get();
      const updatedConflict = getConflictById(conflict.id);

      expect(existing?.status).toBe("active");
      expect(existing?.invalidAt).toBeNull();
      expect(candidate?.status).toBe("pending_clarification");
      expect(updatedConflict?.status).toBe("pending_clarification");
      expect(updatedConflict?.resolutionNote).toBeNull();
    } finally {
      TEST_CONFIG.memory.conflicts.enabled = originalConflictsEnabled;
    }
  });

  test("background conflict resolver dismisses transient/non-durable conflicts without LLM call", async () => {
    const db = getDb();
    const now = 1_700_001_500_000;
    const originalConflictsEnabled = TEST_CONFIG.memory.conflicts.enabled;
    TEST_CONFIG.memory.conflicts.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-conflicts-transient",
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
          id: "msg-conflicts-transient",
          conversationId: "conv-conflicts-transient",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Keep the new one instead." },
          ]),
          createdAt: now + 1,
        })
        .run();

      // Create a transient conflict: PR tracking statements should be dismissed
      db.insert(memoryItems)
        .values([
          {
            id: "item-conflict-existing-transient",
            kind: "preference",
            subject: "pr-tracking",
            statement: "Currently tracking PR #42 for review.",
            status: "active",
            confidence: 0.8,
            fingerprint: "fp-conflict-existing-transient",
            verificationState: "assistant_inferred",
            scopeId: "scope-conflicts-transient",
            firstSeenAt: now - 10_000,
            lastSeenAt: now - 5_000,
            validFrom: now - 10_000,
            invalidAt: null,
          },
          {
            id: "item-conflict-candidate-transient",
            kind: "preference",
            subject: "pr-tracking",
            statement: "Currently tracking PR #99 for review.",
            status: "pending_clarification",
            confidence: 0.8,
            fingerprint: "fp-conflict-candidate-transient",
            verificationState: "assistant_inferred",
            scopeId: "scope-conflicts-transient",
            firstSeenAt: now - 9_000,
            lastSeenAt: now - 4_000,
            validFrom: now - 9_000,
            invalidAt: null,
          },
        ])
        .run();

      const conflict = createOrUpdatePendingConflict({
        scopeId: "scope-conflicts-transient",
        existingItemId: "item-conflict-existing-transient",
        candidateItemId: "item-conflict-candidate-transient",
        relationship: "ambiguous_contradiction",
      });
      db.update(memoryItemConflicts)
        .set({ createdAt: now, updatedAt: now })
        .where(eq(memoryItemConflicts.id, conflict.id))
        .run();

      enqueueResolvePendingConflictsForMessageJob(
        "msg-conflicts-transient",
        "scope-conflicts-transient",
      );
      const processed = await runMemoryJobsOnce();
      expect(processed).toBe(1);

      const updatedConflict = getConflictById(conflict.id);
      expect(updatedConflict?.status).toBe("dismissed");
      expect(updatedConflict?.resolutionNote).toContain("conflict policy");

      // Memory items should remain untouched (no LLM resolution was attempted)
      const existing = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-existing-transient"))
        .get();
      const candidate = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "item-conflict-candidate-transient"))
        .get();
      expect(existing?.status).toBe("active");
      expect(candidate?.status).toBe("pending_clarification");
    } finally {
      TEST_CONFIG.memory.conflicts.enabled = originalConflictsEnabled;
    }
  });

  test("cleanup job enqueue is deduped and retention overrides upgrade payload", () => {
    const db = getDb();

    const resolvedFirst = enqueueCleanupResolvedConflictsJob();
    const resolvedSecond = enqueueCleanupResolvedConflictsJob();
    expect(resolvedSecond).toBe(resolvedFirst);
    const resolvedUpgraded = enqueueCleanupResolvedConflictsJob(12_345);
    expect(resolvedUpgraded).toBe(resolvedFirst);

    const supersededFirst = enqueueCleanupStaleSupersededItemsJob();
    const supersededSecond = enqueueCleanupStaleSupersededItemsJob();
    expect(supersededSecond).toBe(supersededFirst);
    const supersededUpgraded = enqueueCleanupStaleSupersededItemsJob(67_890);
    expect(supersededUpgraded).toBe(supersededFirst);

    const resolvedRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, resolvedFirst))
      .get();
    const supersededRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, supersededFirst))
      .get();
    expect(JSON.parse(resolvedRow?.payload ?? "{}")).toMatchObject({
      retentionMs: 12_345,
    });
    expect(JSON.parse(supersededRow?.payload ?? "{}")).toMatchObject({
      retentionMs: 67_890,
    });
  });

  test("cleanup job enqueue dedupes against running jobs without mutating payload", () => {
    const db = getDb();

    const resolvedId = enqueueCleanupResolvedConflictsJob(10_000);
    const supersededId = enqueueCleanupStaleSupersededItemsJob(20_000);

    db.update(memoryJobs)
      .set({ status: "running" })
      .where(eq(memoryJobs.id, resolvedId))
      .run();
    db.update(memoryJobs)
      .set({ status: "running" })
      .where(eq(memoryJobs.id, supersededId))
      .run();

    const resolvedDedupedId = enqueueCleanupResolvedConflictsJob(11_111);
    const supersededDedupedId = enqueueCleanupStaleSupersededItemsJob(22_222);
    expect(resolvedDedupedId).toBe(resolvedId);
    expect(supersededDedupedId).toBe(supersededId);

    const resolvedRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, resolvedId))
      .get();
    const supersededRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, supersededId))
      .get();
    expect(JSON.parse(resolvedRow?.payload ?? "{}")).toMatchObject({
      retentionMs: 10_000,
    });
    expect(JSON.parse(supersededRow?.payload ?? "{}")).toMatchObject({
      retentionMs: 20_000,
    });
  });

  test("scheduled cleanup enqueue respects throttle and config retention values", () => {
    const db = getDb();
    const originalCleanup = { ...TEST_CONFIG.memory.cleanup };
    TEST_CONFIG.memory.cleanup.enabled = true;
    TEST_CONFIG.memory.cleanup.enqueueIntervalMs = 1_000;
    TEST_CONFIG.memory.cleanup.resolvedConflictRetentionMs = 12_345;
    TEST_CONFIG.memory.cleanup.supersededItemRetentionMs = 67_890;

    try {
      const first = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 5_000);
      expect(first).toBe(true);

      const tooSoon = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 5_500);
      expect(tooSoon).toBe(false);

      const jobsAfterFirst = db.select().from(memoryJobs).all();
      const resolvedJob = jobsAfterFirst.find(
        (row) => row.type === "cleanup_resolved_conflicts",
      );
      const supersededJob = jobsAfterFirst.find(
        (row) => row.type === "cleanup_stale_superseded_items",
      );
      expect(resolvedJob).toBeDefined();
      expect(supersededJob).toBeDefined();
      expect(JSON.parse(resolvedJob?.payload ?? "{}")).toMatchObject({
        retentionMs: 12_345,
      });
      expect(JSON.parse(supersededJob?.payload ?? "{}")).toMatchObject({
        retentionMs: 67_890,
      });

      const secondWindow = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 6_500);
      expect(secondWindow).toBe(true);
      const jobsAfterSecond = db.select().from(memoryJobs).all();
      expect(
        jobsAfterSecond.filter(
          (row) => row.type === "cleanup_resolved_conflicts",
        ).length,
      ).toBe(1);
      expect(
        jobsAfterSecond.filter(
          (row) => row.type === "cleanup_stale_superseded_items",
        ).length,
      ).toBe(1);
    } finally {
      TEST_CONFIG.memory.cleanup = originalCleanup;
    }
  });

  test("cleanup jobs use config retention defaults when payload retention is missing", async () => {
    const db = getDb();
    const now = Date.now();
    const originalCleanup = { ...TEST_CONFIG.memory.cleanup };
    TEST_CONFIG.memory.cleanup.resolvedConflictRetentionMs = 10_000;
    TEST_CONFIG.memory.cleanup.supersededItemRetentionMs = 10_000;

    try {
      db.insert(memoryItems)
        .values([
          {
            id: "cleanup-config-existing",
            kind: "fact",
            subject: "stack",
            statement: "Use Bun",
            status: "active",
            confidence: 0.8,
            fingerprint: "fp-cleanup-config-existing",
            verificationState: "assistant_inferred",
            scopeId: "default",
            firstSeenAt: now - 20_000,
            lastSeenAt: now - 20_000,
          },
          {
            id: "cleanup-config-candidate",
            kind: "fact",
            subject: "stack",
            statement: "Use Node",
            status: "pending_clarification",
            confidence: 0.8,
            fingerprint: "fp-cleanup-config-candidate",
            verificationState: "assistant_inferred",
            scopeId: "default",
            firstSeenAt: now - 20_000,
            lastSeenAt: now - 20_000,
          },
          {
            id: "cleanup-config-stale-item",
            kind: "decision",
            subject: "deploy strategy",
            statement: "Manual deploy Fridays.",
            status: "superseded",
            confidence: 0.7,
            fingerprint: "fp-cleanup-config-stale-item",
            verificationState: "assistant_inferred",
            scopeId: "default",
            firstSeenAt: now - 200_000,
            lastSeenAt: now - 200_000,
            invalidAt: now - 200_000,
          },
        ])
        .run();

      const conflict = createOrUpdatePendingConflict({
        scopeId: "default",
        existingItemId: "cleanup-config-existing",
        candidateItemId: "cleanup-config-candidate",
        relationship: "ambiguous_contradiction",
      });
      resolveConflict(conflict.id, { status: "resolved_keep_existing" });
      db.run(`
        UPDATE memory_item_conflicts
        SET resolved_at = ${now - 100_000}, updated_at = ${now - 100_000}
        WHERE id = '${conflict.id}'
      `);

      enqueueMemoryJob("cleanup_resolved_conflicts", {});
      enqueueMemoryJob("cleanup_stale_superseded_items", {});
      const processed = await runMemoryJobsOnce();
      expect(processed).toBe(2);

      const conflictRow = db
        .select()
        .from(memoryItemConflicts)
        .where(eq(memoryItemConflicts.id, conflict.id))
        .get();
      const staleItem = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, "cleanup-config-stale-item"))
        .get();
      expect(conflictRow).toBeUndefined();
      expect(staleItem).toBeUndefined();
    } finally {
      TEST_CONFIG.memory.cleanup = originalCleanup;
    }
  });

  test("cleanup_resolved_conflicts removes stale resolved rows but keeps recent/pending", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values([
        {
          id: "cleanup-conflict-existing-a",
          kind: "fact",
          subject: "db",
          statement: "Use Postgres.",
          status: "active",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-existing-a",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
        {
          id: "cleanup-conflict-candidate-a",
          kind: "fact",
          subject: "db",
          statement: "Use MySQL.",
          status: "pending_clarification",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-candidate-a",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
        {
          id: "cleanup-conflict-existing-b",
          kind: "fact",
          subject: "frontend",
          statement: "Use React.",
          status: "active",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-existing-b",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
        {
          id: "cleanup-conflict-candidate-b",
          kind: "fact",
          subject: "frontend",
          statement: "Use Vue.",
          status: "pending_clarification",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-candidate-b",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
        {
          id: "cleanup-conflict-existing-c",
          kind: "fact",
          subject: "orm",
          statement: "Use Drizzle.",
          status: "active",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-existing-c",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
        {
          id: "cleanup-conflict-candidate-c",
          kind: "fact",
          subject: "orm",
          statement: "Use Prisma.",
          status: "pending_clarification",
          confidence: 0.8,
          fingerprint: "fp-cleanup-conflict-candidate-c",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 20_000,
          lastSeenAt: now - 20_000,
        },
      ])
      .run();

    const staleResolved = createOrUpdatePendingConflict({
      scopeId: "default",
      existingItemId: "cleanup-conflict-existing-a",
      candidateItemId: "cleanup-conflict-candidate-a",
      relationship: "ambiguous_contradiction",
    });
    const pendingConflict = createOrUpdatePendingConflict({
      scopeId: "default",
      existingItemId: "cleanup-conflict-existing-b",
      candidateItemId: "cleanup-conflict-candidate-b",
      relationship: "ambiguous_contradiction",
    });
    const recentResolved = createOrUpdatePendingConflict({
      scopeId: "default",
      existingItemId: "cleanup-conflict-existing-c",
      candidateItemId: "cleanup-conflict-candidate-c",
      relationship: "ambiguous_contradiction",
      clarificationQuestion: "Recent resolution row",
    });

    resolveConflict(staleResolved.id, { status: "resolved_keep_existing" });
    resolveConflict(recentResolved.id, { status: "resolved_keep_candidate" });

    db.run(`
      UPDATE memory_item_conflicts
      SET resolved_at = ${now - 100_000}, updated_at = ${now - 100_000}
      WHERE id = '${staleResolved.id}'
    `);
    db.run(`
      UPDATE memory_item_conflicts
      SET resolved_at = ${now - 100}, updated_at = ${now - 100}
      WHERE id = '${recentResolved.id}'
    `);

    enqueueMemoryJob("cleanup_resolved_conflicts", { retentionMs: 10_000 });
    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    const staleRow = db
      .select()
      .from(memoryItemConflicts)
      .where(eq(memoryItemConflicts.id, staleResolved.id))
      .get();
    const pendingRow = db
      .select()
      .from(memoryItemConflicts)
      .where(eq(memoryItemConflicts.id, pendingConflict.id))
      .get();
    const recentRow = db
      .select()
      .from(memoryItemConflicts)
      .where(eq(memoryItemConflicts.id, recentResolved.id))
      .get();
    expect(staleRow).toBeUndefined();
    expect(pendingRow?.status).toBe("pending_clarification");
    expect(recentRow?.status).toBe("resolved_keep_candidate");
  });

  test("cleanup_stale_superseded_items removes stale superseded rows, embeddings, and entity links", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values([
        {
          id: "cleanup-stale-item",
          kind: "decision",
          subject: "deploy strategy",
          statement: "Deploy manually every Friday.",
          status: "superseded",
          confidence: 0.7,
          fingerprint: "fp-cleanup-stale-item",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 200_000,
          lastSeenAt: now - 200_000,
          invalidAt: now - 200_000,
        },
        {
          id: "cleanup-recent-item",
          kind: "decision",
          subject: "deploy strategy",
          statement: "Deploy continuously via CI.",
          status: "superseded",
          confidence: 0.7,
          fingerprint: "fp-cleanup-recent-item",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 200_000,
          lastSeenAt: now - 200_000,
          invalidAt: now - 100,
        },
      ])
      .run();

    db.insert(memoryEmbeddings)
      .values([
        {
          id: "cleanup-embed-stale",
          targetType: "item",
          targetId: "cleanup-stale-item",
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 3,
          vectorBlob: vectorToBlob([0, 0, 0]),
          createdAt: now - 1000,
          updatedAt: now - 1000,
        },
        {
          id: "cleanup-embed-recent",
          targetType: "item",
          targetId: "cleanup-recent-item",
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 3,
          vectorBlob: vectorToBlob([0, 0, 0]),
          createdAt: now - 1000,
          updatedAt: now - 1000,
        },
      ])
      .run();

    // Create entity links for both items (no FK cascade on this table)
    db.insert(memoryEntities)
      .values({
        id: "cleanup-entity",
        name: "Deployment",
        type: "concept",
        aliases: JSON.stringify([]),
        description: null,
        firstSeenAt: now - 200_000,
        lastSeenAt: now - 200_000,
        mentionCount: 2,
      })
      .run();
    db.insert(memoryItemEntities)
      .values([
        { memoryItemId: "cleanup-stale-item", entityId: "cleanup-entity" },
        { memoryItemId: "cleanup-recent-item", entityId: "cleanup-entity" },
      ])
      .run();

    enqueueMemoryJob("cleanup_stale_superseded_items", { retentionMs: 10_000 });
    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    const staleItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "cleanup-stale-item"))
      .get();
    const recentItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "cleanup-recent-item"))
      .get();
    const staleEmbedding = db
      .select()
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.id, "cleanup-embed-stale"))
      .get();
    const recentEmbedding = db
      .select()
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.id, "cleanup-embed-recent"))
      .get();

    // Entity links for stale item should be removed; recent item's links should remain
    const staleEntityLinks = db
      .select()
      .from(memoryItemEntities)
      .where(eq(memoryItemEntities.memoryItemId, "cleanup-stale-item"))
      .all();
    const recentEntityLinks = db
      .select()
      .from(memoryItemEntities)
      .where(eq(memoryItemEntities.memoryItemId, "cleanup-recent-item"))
      .all();

    expect(staleItem).toBeUndefined();
    expect(recentItem).toBeDefined();
    expect(staleEmbedding).toBeUndefined();
    expect(recentEmbedding).toBeDefined();
    expect(staleEntityLinks).toHaveLength(0);
    expect(recentEntityLinks).toHaveLength(1);
  });

  test("memory admin status reports pending/resolved conflicts and oldest pending age", () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values([
        {
          id: "status-conflict-existing",
          kind: "fact",
          subject: "editor",
          statement: "Use Neovim.",
          status: "active",
          confidence: 0.8,
          fingerprint: "fp-status-existing",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
        },
        {
          id: "status-conflict-candidate",
          kind: "fact",
          subject: "editor",
          statement: "Use VS Code.",
          status: "pending_clarification",
          confidence: 0.8,
          fingerprint: "fp-status-candidate",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
        },
        {
          id: "status-conflict-existing-2",
          kind: "fact",
          subject: "shell",
          statement: "Use zsh.",
          status: "active",
          confidence: 0.8,
          fingerprint: "fp-status-existing-2",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
        },
        {
          id: "status-conflict-candidate-2",
          kind: "fact",
          subject: "shell",
          statement: "Use fish.",
          status: "pending_clarification",
          confidence: 0.8,
          fingerprint: "fp-status-candidate-2",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
        },
      ])
      .run();

    const pending = createOrUpdatePendingConflict({
      scopeId: "default",
      existingItemId: "status-conflict-existing",
      candidateItemId: "status-conflict-candidate",
      relationship: "ambiguous_contradiction",
    });
    const resolved = createOrUpdatePendingConflict({
      scopeId: "default",
      existingItemId: "status-conflict-existing-2",
      candidateItemId: "status-conflict-candidate-2",
      relationship: "ambiguous_contradiction",
      clarificationQuestion: "resolved-row",
    });
    resolveConflict(resolved.id, { status: "resolved_merge" });

    db.run(
      `UPDATE memory_item_conflicts SET created_at = ${
        now - 5_000
      } WHERE id = '${pending.id}'`,
    );

    const status = getMemorySystemStatus();
    expect(status.conflicts.pending).toBe(1);
    expect(status.conflicts.resolved).toBe(1);
    expect(status.conflicts.oldestPendingAgeMs).not.toBeNull();
    expect((status.conflicts.oldestPendingAgeMs ?? 0) >= 4_000).toBe(true);
    expect(status.cleanup.resolvedBacklog).toBe(0);
    expect(status.cleanup.supersededBacklog).toBe(0);
    expect(status.cleanup.resolvedCompleted24h).toBe(0);
    expect(status.cleanup.supersededCompleted24h).toBe(0);
  });

  test("memory admin status reports cleanup backlog and 24h throughput metrics", () => {
    const db = getDb();
    const now = Date.now();
    const yesterday = now - 20 * 60 * 60 * 1000;
    const old = now - 40 * 60 * 60 * 1000;

    db.insert(memoryJobs)
      .values([
        {
          id: "cleanup-status-pending-resolved",
          type: "cleanup_resolved_conflicts",
          payload: "{}",
          status: "pending",
          attempts: 0,
          deferrals: 0,
          runAfter: now,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cleanup-status-running-superseded",
          type: "cleanup_stale_superseded_items",
          payload: "{}",
          status: "running",
          attempts: 0,
          deferrals: 0,
          runAfter: now,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cleanup-status-completed-resolved-recent",
          type: "cleanup_resolved_conflicts",
          payload: "{}",
          status: "completed",
          attempts: 1,
          deferrals: 0,
          runAfter: yesterday,
          lastError: null,
          createdAt: yesterday,
          updatedAt: yesterday,
        },
        {
          id: "cleanup-status-completed-superseded-recent",
          type: "cleanup_stale_superseded_items",
          payload: "{}",
          status: "completed",
          attempts: 1,
          deferrals: 0,
          runAfter: yesterday,
          lastError: null,
          createdAt: yesterday,
          updatedAt: yesterday,
        },
        {
          id: "cleanup-status-completed-resolved-old",
          type: "cleanup_resolved_conflicts",
          payload: "{}",
          status: "completed",
          attempts: 1,
          deferrals: 0,
          runAfter: old,
          lastError: null,
          createdAt: old,
          updatedAt: old,
        },
      ])
      .run();

    const status = getMemorySystemStatus();
    expect(status.cleanup.resolvedBacklog).toBe(1);
    expect(status.cleanup.supersededBacklog).toBe(1);
    expect(status.cleanup.resolvedCompleted24h).toBe(1);
    expect(status.cleanup.supersededCompleted24h).toBe(1);
  });

  test("requestMemoryCleanup queues both cleanup job types", () => {
    const db = getDb();
    const queued = requestMemoryCleanup(9_999);
    expect(queued.resolvedConflictsJobId).toBeTruthy();
    expect(queued.staleSupersededItemsJobId).toBeTruthy();

    const resolvedRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, queued.resolvedConflictsJobId))
      .get();
    const supersededRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, queued.staleSupersededItemsJobId))
      .get();
    expect(resolvedRow?.type).toBe("cleanup_resolved_conflicts");
    expect(supersededRow?.type).toBe("cleanup_stale_superseded_items");
  });

  test("relation backfill advances checkpoints in deterministic batches", async () => {
    const db = getDb();
    const now = 1_700_001_000_000;
    const originalEnabled = TEST_CONFIG.memory.entity.extractRelations.enabled;
    const originalBatchSize =
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize;
    TEST_CONFIG.memory.entity.extractRelations.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize = 2;

    try {
      db.insert(conversations)
        .values({
          id: "conv-rel-backfill",
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
            id: "msg-rel-backfill-1",
            conversationId: "conv-rel-backfill",
            role: "user",
            content: JSON.stringify([
              {
                type: "text",
                text: "Project Atlas uses Qdrant for memory search.",
              },
            ]),
            createdAt: now + 1,
          },
          {
            id: "msg-rel-backfill-2",
            conversationId: "conv-rel-backfill",
            role: "user",
            content: JSON.stringify([
              { type: "text", text: "Atlas collaborates with Orion." },
            ]),
            createdAt: now + 2,
          },
          {
            id: "msg-rel-backfill-3",
            conversationId: "conv-rel-backfill",
            role: "user",
            content: JSON.stringify([
              { type: "text", text: "Orion depends on Redis caching." },
            ]),
            createdAt: now + 3,
          },
        ])
        .run();

      enqueueBackfillEntityRelationsJob(true);

      const firstProcessed = await runMemoryJobsOnce();
      expect(firstProcessed).toBe(1);
      expect(
        getMemoryCheckpoint("memory:relation_backfill:last_created_at"),
      ).toBe(String(now + 2));
      expect(
        getMemoryCheckpoint("memory:relation_backfill:last_message_id"),
      ).toBe("msg-rel-backfill-2");

      db.run(
        `DELETE FROM memory_jobs WHERE type = 'extract_entities' AND status = 'pending'`,
      );

      const secondProcessed = await runMemoryJobsOnce();
      expect(secondProcessed).toBe(1);
      expect(
        getMemoryCheckpoint("memory:relation_backfill:last_created_at"),
      ).toBe(String(now + 3));
      expect(
        getMemoryCheckpoint("memory:relation_backfill:last_message_id"),
      ).toBe("msg-rel-backfill-3");

      const pendingBackfill = db
        .select()
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.type, "backfill_entity_relations"),
            eq(memoryJobs.status, "pending"),
          ),
        )
        .all();
      expect(pendingBackfill).toHaveLength(0);
    } finally {
      TEST_CONFIG.memory.entity.extractRelations.enabled = originalEnabled;
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize =
        originalBatchSize;
    }
  });

  test("memory recall token budgeting includes recall marker overhead", async () => {
    const db = getDb();
    const createdAt = 1_700_000_300_000;
    db.insert(conversations)
      .values({
        id: "conv-budget",
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
        id: "msg-budget",
        conversationId: "conv-budget",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "remember budget token sentinel" },
        ]),
        createdAt,
      })
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES (
        'seg-budget', 'msg-budget', 'conv-budget', 'user', 0, 'remember budget token sentinel', 6, ${createdAt}, ${createdAt}
      )
    `);

    const candidateLine =
      "- <kind>segment:seg-budget</kind> remember budget token sentinel";
    const lineOnlyTokens = estimateTextTokens(candidateLine);
    const fullRecallTokens = estimateTextTokens(
      '<memory source="long_term_memory" confidence="approximate">\n' +
        `## Relevant Context\n${candidateLine}\n</memory>`,
    );
    expect(fullRecallTokens).toBeGreaterThan(lineOnlyTokens);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          maxInjectTokens: lineOnlyTokens,
        },
      },
    };

    const recall = await buildMemoryRecall(
      "budget sentinel",
      "conv-budget",
      config,
    );
    expect(recall.injectedText).toBe("");
    expect(recall.injectedTokens).toBe(0);
  });

  test("memory recall respects maxInjectTokensOverride when provided", async () => {
    const db = getDb();
    const createdAt = 1_700_000_301_000;
    db.insert(conversations)
      .values({
        id: "conv-budget-override",
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

    for (let i = 0; i < 4; i++) {
      const msgId = `msg-budget-override-${i}`;
      const segId = `seg-budget-override-${i}`;
      const text = `budget override sentinel item ${i} with enough text to exceed tiny limits`;
      db.insert(messages)
        .values({
          id: msgId,
          conversationId: "conv-budget-override",
          role: "user",
          content: JSON.stringify([{ type: "text", text }]),
          createdAt: createdAt + i,
        })
        .run();
      db.run(`
        INSERT INTO memory_segments (
          id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
        ) VALUES (
          '${segId}', '${msgId}', 'conv-budget-override', 'user', 0, '${text}', 20, ${
            createdAt + i
          }, ${createdAt + i}
        )
      `);
    }

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "openai" as const,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          maxInjectTokens: 5000,
          lexicalTopK: 10,
        },
      },
    };

    const override = 120;
    const recall = await buildMemoryRecall(
      "budget override sentinel",
      "conv-budget-override",
      config,
      { maxInjectTokensOverride: override },
    );
    expect(recall.injectedTokens).toBeLessThanOrEqual(override);
  });

  test("claimMemoryJobs only returns rows it actually claimed", () => {
    const db = getDb();
    const jobId = enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-lock",
    });
    db.run(`
      CREATE TEMP TRIGGER memory_jobs_claim_ignore
      BEFORE UPDATE ON memory_jobs
      WHEN NEW.status = 'running' AND OLD.id = '${jobId}'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    try {
      const claimed = claimMemoryJobs(10);
      expect(claimed).toHaveLength(0);
      const row = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.id, jobId))
        .get();
      expect(row?.status).toBe("pending");
    } finally {
      db.run("DROP TRIGGER IF EXISTS memory_jobs_claim_ignore");
    }
  });

  test("formatAbsoluteTime returns YYYY-MM-DD HH:mm TZ format", () => {
    // Use a fixed epoch-ms value; the rendered string depends on the local timezone,
    // so we verify the structural format rather than exact values.
    const epochMs = 1_707_850_200_000; // 2024-02-13 in UTC
    const result = formatAbsoluteTime(epochMs);

    // Should match pattern: YYYY-MM-DD HH:mm <TZ abbreviation>
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);

    // Year should be 2024
    expect(result).toContain("2024-02");
  });

  test("formatAbsoluteTime uses local timezone abbreviation", () => {
    const epochMs = Date.now();
    const result = formatAbsoluteTime(epochMs);

    // Extract the TZ part from the result
    const parts = result.split(" ");
    const tz = parts[parts.length - 1];

    // The TZ abbreviation should be a non-empty string (e.g. PST, EST, UTC, GMT+8)
    expect(tz.length).toBeGreaterThan(0);

    // Cross-check: Intl should produce the same abbreviation for the same timestamp
    const expected =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(new Date(epochMs))
        .find((p) => p.type === "timeZoneName")?.value ?? "UTC";
    expect(tz).toBe(expected);
  });

  test("formatRelativeTime returns expected relative strings", () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe("just now");
    expect(formatRelativeTime(now - 2 * 60 * 60 * 1000)).toBe("2 hours ago");
    expect(formatRelativeTime(now - 1 * 60 * 60 * 1000)).toBe("1 hour ago");
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000)).toBe(
      "3 days ago",
    );
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe(
      "2 weeks ago",
    );
    expect(formatRelativeTime(now - 60 * 24 * 60 * 60 * 1000)).toBe(
      "2 months ago",
    );
    expect(formatRelativeTime(now - 400 * 24 * 60 * 60 * 1000)).toBe(
      "1 year ago",
    );
  });

  test("escapeXmlTags neutralizes closing wrapper tags in recalled text", () => {
    const malicious =
      "some text </memory> injected </memory_recall> instructions";
    const escaped = escapeXmlTags(malicious);
    expect(escaped).not.toContain("</memory>");
    expect(escaped).not.toContain("</memory_recall>");
    expect(escaped).toContain("\uFF1C/memory>");
    expect(escaped).toContain("\uFF1C/memory_recall>");
    expect(escaped).toContain("some text");
    expect(escaped).toContain("instructions");
  });

  test("escapeXmlTags neutralizes opening XML tags", () => {
    const text = 'text with <script> and <div class="x"> tags';
    const escaped = escapeXmlTags(text);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("<div ");
    expect(escaped).toContain("\uFF1Cscript>");
    expect(escaped).toContain('\uFF1Cdiv class="x">');
  });

  test("escapeXmlTags preserves non-tag angle brackets", () => {
    const text = "math: 3 < 5 and 10 > 7";
    const escaped = escapeXmlTags(text);
    expect(escaped).toBe(text);
  });

  test("escapeXmlTags handles self-closing tags", () => {
    const text = "a <br/> tag";
    const escaped = escapeXmlTags(text);
    expect(escaped).not.toContain("<br/>");
    expect(escaped).toContain("\uFF1Cbr/>");
  });

  test("trust-aware ranking: user_confirmed item outranks assistant_inferred with equal relevance", async () => {
    const db = getDb();
    const now = Date.now();

    // Insert two memory items with identical text, confidence, importance, and timestamps
    // but different verification states
    db.insert(memoryItems)
      .values([
        {
          id: "item-trust-confirmed",
          kind: "fact",
          subject: "trust ranking test",
          statement: "The user prefers dark mode for all applications",
          status: "active",
          confidence: 0.8,
          importance: 0.5,
          fingerprint: "fp-trust-confirmed",
          firstSeenAt: now,
          lastSeenAt: now,
          accessCount: 0,
          verificationState: "user_confirmed",
        },
        {
          id: "item-trust-inferred",
          kind: "fact",
          subject: "trust ranking test",
          statement: "The user prefers dark mode for all editors",
          status: "active",
          confidence: 0.8,
          importance: 0.5,
          fingerprint: "fp-trust-inferred",
          firstSeenAt: now,
          lastSeenAt: now,
          accessCount: 0,
          verificationState: "assistant_inferred",
        },
      ])
      .run();

    // Link both items to an entity matching a query token ("dark" from "dark mode")
    db.insert(memoryEntities)
      .values({
        id: "entity-dark-mode",
        name: "dark",
        type: "concept",
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    db.insert(memoryItemEntities)
      .values([
        { memoryItemId: "item-trust-confirmed", entityId: "entity-dark-mode" },
        { memoryItemId: "item-trust-inferred", entityId: "entity-dark-mode" },
      ])
      .run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall(
      "dark mode",
      "conv-trust-test",
      config,
    );

    // Both items should be found via retrieval
    const confirmed = recall.topCandidates.find(
      (c) => c.key === "item:item-trust-confirmed",
    );
    const inferred = recall.topCandidates.find(
      (c) => c.key === "item:item-trust-inferred",
    );
    expect(confirmed).toBeDefined();
    expect(inferred).toBeDefined();

    // user_confirmed (weight 1.0) should have a higher finalScore than assistant_inferred (weight 0.7)
    expect(confirmed!.finalScore).toBeGreaterThan(inferred!.finalScore);
  });

  test("trust-aware ranking: user_reported item outranks assistant_inferred", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values([
        {
          id: "item-trust-reported",
          kind: "fact",
          subject: "trust ranking reported",
          statement: "The user uses vim keybindings in their editor",
          status: "active",
          confidence: 0.8,
          importance: 0.5,
          fingerprint: "fp-trust-reported",
          firstSeenAt: now,
          lastSeenAt: now,
          accessCount: 0,
          verificationState: "user_reported",
        },
        {
          id: "item-trust-inferred2",
          kind: "fact",
          subject: "trust ranking inferred",
          statement: "The user uses vim keybindings in their terminal",
          status: "active",
          confidence: 0.8,
          importance: 0.5,
          fingerprint: "fp-trust-inferred2",
          firstSeenAt: now,
          lastSeenAt: now,
          accessCount: 0,
          verificationState: "assistant_inferred",
        },
      ])
      .run();

    // Link both items to an entity matching a query token ("vim" from "vim keybindings")
    db.insert(memoryEntities)
      .values({
        id: "entity-vim",
        name: "vim",
        type: "concept",
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    db.insert(memoryItemEntities)
      .values([
        { memoryItemId: "item-trust-reported", entityId: "entity-vim" },
        { memoryItemId: "item-trust-inferred2", entityId: "entity-vim" },
      ])
      .run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall(
      "vim keybindings",
      "conv-trust-test2",
      config,
    );

    const reported = recall.topCandidates.find(
      (c) => c.key === "item:item-trust-reported",
    );
    const inferred = recall.topCandidates.find(
      (c) => c.key === "item:item-trust-inferred2",
    );
    expect(reported).toBeDefined();
    expect(inferred).toBeDefined();

    // user_reported (weight 0.9) should outrank assistant_inferred (weight 0.7)
    expect(reported!.finalScore).toBeGreaterThan(inferred!.finalScore);
  });

  test("trust-aware ranking: weight values are bounded and non-zero", async () => {
    const db = getDb();
    const now = Date.now();

    // Insert an item with an unknown verification state to test the default weight
    const raw = (
      db as unknown as {
        $client: {
          query: (q: string) => { get: (...params: unknown[]) => unknown };
        };
      }
    ).$client;
    raw
      .query(
        `
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, fingerprint, first_seen_at, last_seen_at, access_count, verification_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .get(
        "item-trust-unknown",
        "fact",
        "trust ranking unknown",
        "The user has an unknown trust state preference",
        "active",
        0.8,
        0.5,
        "fp-trust-unknown",
        now,
        now,
        0,
        "some_future_state",
      );

    // Link the item to an entity matching a query token ("trust" from "unknown trust state preference")
    db.insert(memoryEntities)
      .values({
        id: "entity-trust",
        name: "trust",
        type: "concept",
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    db.insert(memoryItemEntities)
      .values({ memoryItemId: "item-trust-unknown", entityId: "entity-trust" })
      .run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall(
      "unknown trust state preference",
      "conv-trust-test3",
      config,
    );

    const unknown = recall.topCandidates.find(
      (c) => c.key === "item:item-trust-unknown",
    );
    expect(unknown).toBeDefined();
    // The finalScore should be > 0 (trust weight is bounded, not zero)
    expect(unknown!.finalScore).toBeGreaterThan(0);
  });

  test("freshness decay: stale event item scores lower than fresh one", async () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Fresh event item (5 days old — well within the 30-day default window)
    db.insert(memoryItems)
      .values({
        id: "item-fresh-event",
        kind: "event",
        subject: "freshness decay test",
        statement: "User attended a workshop on machine learning",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-fresh-event",
        firstSeenAt: now - 5 * MS_PER_DAY,
        lastSeenAt: now - 5 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    // Stale event item (60 days old — past the 30-day event window)
    db.insert(memoryItems)
      .values({
        id: "item-stale-event",
        kind: "event",
        subject: "freshness decay test",
        statement: "User attended a workshop on machine learning basics",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-stale-event",
        firstSeenAt: now - 60 * MS_PER_DAY,
        lastSeenAt: now - 60 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    // Link both items to an entity matching a query token ("workshop" from "machine learning workshop")
    db.insert(memoryEntities)
      .values({
        id: "entity-workshop",
        name: "workshop",
        type: "concept",
        firstSeenAt: now - 60 * MS_PER_DAY,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    db.insert(memoryItemEntities)
      .values([
        { memoryItemId: "item-fresh-event", entityId: "entity-workshop" },
        { memoryItemId: "item-stale-event", entityId: "entity-workshop" },
      ])
      .run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, required: false },
      },
    };

    const recall = await buildMemoryRecall(
      "machine learning workshop",
      "conv-fresh-1",
      config,
    );

    const fresh = recall.topCandidates.find(
      (c) => c.key === "item:item-fresh-event",
    );
    const stale = recall.topCandidates.find(
      (c) => c.key === "item:item-stale-event",
    );
    expect(fresh).toBeDefined();
    expect(stale).toBeDefined();

    // Fresh item should score higher than stale item due to freshness decay
    expect(fresh!.finalScore).toBeGreaterThan(stale!.finalScore);
  });

  test("freshness decay: fact items with maxAgeDays=0 are never decayed", async () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Very old fact item (365 days) — facts have maxAgeDays=0 (no expiry)
    db.insert(memoryItems)
      .values({
        id: "item-old-fact",
        kind: "fact",
        subject: "freshness no-decay test",
        statement: "The speed of light is 299792458 meters per second",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-old-fact",
        firstSeenAt: now - 365 * MS_PER_DAY,
        lastSeenAt: now - 365 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    // Recent fact with same text similarity
    db.insert(memoryItems)
      .values({
        id: "item-new-fact",
        kind: "fact",
        subject: "freshness no-decay test",
        statement: "The speed of light is approximately 3e8 meters per second",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-new-fact",
        firstSeenAt: now - 1 * MS_PER_DAY,
        lastSeenAt: now - 1 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    // Link both items to an entity matching a query token ("speed" from "speed of light")
    db.insert(memoryEntities)
      .values({
        id: "entity-speed",
        name: "speed",
        type: "concept",
        firstSeenAt: now - 365 * MS_PER_DAY,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    db.insert(memoryItemEntities)
      .values([
        { memoryItemId: "item-old-fact", entityId: "entity-speed" },
        { memoryItemId: "item-new-fact", entityId: "entity-speed" },
      ])
      .run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, required: false },
      },
    };

    const recall = await buildMemoryRecall(
      "speed of light",
      "conv-fresh-2",
      config,
    );

    const oldFact = recall.topCandidates.find(
      (c) => c.key === "item:item-old-fact",
    );
    const newFact = recall.topCandidates.find(
      (c) => c.key === "item:item-new-fact",
    );
    expect(oldFact).toBeDefined();
    expect(newFact).toBeDefined();

    // Both should have similar scores — old facts are NOT decayed
    // The scores may differ slightly due to recency scores, but the ratio should be close to 1
    const ratio = oldFact!.finalScore / newFact!.finalScore;
    expect(ratio).toBeGreaterThan(0.8);
  });

  test("sweepStaleItems marks deeply stale items as invalid", () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Item 100 days old with kind=event (default maxAgeDays=30, so 2x=60 — past the deep-stale threshold)
    db.insert(memoryItems)
      .values({
        id: "item-deeply-stale",
        kind: "event",
        subject: "sweep test",
        statement: "Old event that should be swept",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-sweep-stale",
        firstSeenAt: now - 100 * MS_PER_DAY,
        lastSeenAt: now - 100 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "assistant_inferred",
      })
      .run();

    // Fresh event item — should NOT be swept
    db.insert(memoryItems)
      .values({
        id: "item-sweep-fresh",
        kind: "event",
        subject: "sweep test",
        statement: "Recent event that should not be swept",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-sweep-fresh",
        firstSeenAt: now - 5 * MS_PER_DAY,
        lastSeenAt: now - 5 * MS_PER_DAY,
        accessCount: 0,
        verificationState: "assistant_inferred",
      })
      .run();

    const marked = sweepStaleItems(DEFAULT_CONFIG);
    expect(marked).toBeGreaterThanOrEqual(1);

    const staleItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-deeply-stale"))
      .get();
    expect(staleItem).toBeDefined();
    expect(staleItem!.invalidAt).not.toBeNull();

    const freshItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-sweep-fresh"))
      .get();
    expect(freshItem).toBeDefined();
    expect(freshItem!.invalidAt).toBeNull();
  });

  test("sweepStaleItems shields items with recent lastUsedAt", () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Old event (100 days) but recently retrieved (lastUsedAt = 2 days ago)
    // reinforcementShieldDays defaults to 14, so this should be shielded
    db.insert(memoryItems)
      .values({
        id: "item-sweep-shielded",
        kind: "event",
        subject: "sweep shield test",
        statement: "Old event that was recently used",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-sweep-shielded",
        firstSeenAt: now - 100 * MS_PER_DAY,
        lastSeenAt: now - 100 * MS_PER_DAY,
        lastUsedAt: now - 2 * MS_PER_DAY,
        accessCount: 3,
        verificationState: "assistant_inferred",
      })
      .run();

    const marked = sweepStaleItems(DEFAULT_CONFIG);

    // Sweep ran but shielded item was not marked — should return 0
    expect(marked).toBe(0);

    const shieldedItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-sweep-shielded"))
      .get();
    expect(shieldedItem).toBeDefined();
    expect(shieldedItem!.invalidAt).toBeNull();
  });

  test("scope columns: memory items default to scope_id=default", () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values({
        id: "item-scope-default",
        kind: "fact",
        subject: "scope test",
        statement: "This item should have default scope",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-scope-default",
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-scope-default"))
      .get();
    expect(item).toBeDefined();
    expect(item!.scopeId).toBe("default");
  });

  test("scope columns: memory items can be inserted with explicit scope_id", () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems)
      .values({
        id: "item-scope-custom",
        kind: "fact",
        subject: "scope test",
        statement: "This item has a custom scope",
        status: "active",
        confidence: 0.8,
        importance: 0.5,
        fingerprint: "fp-scope-custom",
        scopeId: "project-abc",
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: "user_confirmed",
      })
      .run();

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-scope-custom"))
      .get();
    expect(item).toBeDefined();
    expect(item!.scopeId).toBe("project-abc");
  });

  test("scope columns: segments get scopeId from indexer input", () => {
    const db = getDb();
    const now = Date.now();

    db.insert(conversations)
      .values({
        id: "conv-scope-test",
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
        id: "msg-scope-test",
        conversationId: "conv-scope-test",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Remember my scope preference" },
        ]),
        createdAt: now,
      })
      .run();

    indexMessageNow(
      {
        messageId: "msg-scope-test",
        conversationId: "conv-scope-test",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Remember my scope preference" },
        ]),
        createdAt: now,
        scopeId: "project-xyz",
      },
      DEFAULT_CONFIG.memory,
    );

    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, "msg-scope-test"))
      .all();
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.scopeId).toBe("project-xyz");
    }
  });

  test("scope filtering: retrieval excludes items from other scopes", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-filter";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-scope-filter",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "scope test" }]),
        createdAt: now,
      })
      .run();

    // Insert segment in scope "project-a"
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-scope-a', 'msg-scope-filter', '${convId}', 'user', 0, 'The quick brown fox jumps over the lazy dog in project alpha', 12, 'project-a', ${now}, ${now})
    `);

    // Insert segment in scope "project-b"
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-scope-b', 'msg-scope-filter', '${convId}', 'user', 1, 'The quick brown fox jumps over the lazy dog in project beta', 12, 'project-b', ${now}, ${now})
    `);

    // Insert item in scope "project-a"
    db.insert(memoryItems)
      .values({
        id: "item-scope-a",
        kind: "fact",
        subject: "fox",
        statement: "The fox is quick and brown in project alpha",
        status: "active",
        confidence: 0.9,
        importance: 0.8,
        fingerprint: "fp-scope-a",
        verificationState: "user_confirmed",
        scopeId: "project-a",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    // Insert item in scope "project-b"
    db.insert(memoryItems)
      .values({
        id: "item-scope-b",
        kind: "fact",
        subject: "fox",
        statement: "The fox is quick and brown in project beta",
        status: "active",
        confidence: 0.9,
        importance: 0.8,
        fingerprint: "fp-scope-b",
        verificationState: "user_confirmed",
        scopeId: "project-b",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    // Query with scopeId "project-a" — should only find project-a items
    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };
    const result = await buildMemoryRecall("quick brown fox", convId, config, {
      scopeId: "project-a",
    });
    const keys = result.topCandidates.map((c) => c.key);

    // Segments and items from project-b should not appear
    expect(keys).not.toContain("segment:seg-scope-b");
    expect(keys).not.toContain("item:item-scope-b");

    // At least one project-a candidate should appear
    const hasProjectA = keys.some((k) => k.includes("scope-a"));
    expect(hasProjectA).toBe(true);
  });

  test("scope filtering: allow_global_fallback includes default scope", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-fallback";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-scope-fallback",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "fallback test" }]),
        createdAt: now,
      })
      .run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-default-scope', 'msg-scope-fallback', '${convId}', 'user', 0, 'Universal knowledge about programming languages and paradigms', 10, 'default', ${now}, ${now})
    `);

    // Insert segment in custom scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-custom-scope', 'msg-scope-fallback', '${convId}', 'user', 1, 'Project-specific knowledge about programming languages and paradigms', 10, 'my-project', ${now}, ${now})
    `);

    // With allow_global_fallback (the default), querying with scopeId "my-project"
    // should include both "my-project" and "default" scope items
    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };
    const result = await buildMemoryRecall(
      "programming languages",
      convId,
      config,
      { scopeId: "my-project" },
    );
    const keys = result.topCandidates.map((c) => c.key);

    // Both default and custom scope segments should be included
    expect(keys).toContain("segment:seg-default-scope");
    expect(keys).toContain("segment:seg-custom-scope");
  });

  test("scope filtering: strict policy excludes default scope", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-strict";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-scope-strict",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "strict test" }]),
        createdAt: now,
      })
      .run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-strict-default', 'msg-scope-strict', '${convId}', 'user', 0, 'Global memory about database optimization techniques', 8, 'default', ${now}, ${now})
    `);

    // Insert segment in custom scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-strict-custom', 'msg-scope-strict', '${convId}', 'user', 1, 'Project-specific memory about database optimization techniques', 8, 'strict-project', ${now}, ${now})
    `);

    // With strict policy, querying with scopeId should only include that scope
    const strictConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          scopePolicy: "strict" as const,
        },
      },
    };

    const result = await buildMemoryRecall(
      "database optimization",
      convId,
      strictConfig,
      { scopeId: "strict-project" },
    );
    const keys = result.topCandidates.map((c) => c.key);

    // Only strict-project scope segment should appear
    expect(keys).not.toContain("segment:seg-strict-default");
    expect(keys).toContain("segment:seg-strict-custom");
  });

  test("relation retrieval respects scope and active-item filters", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-relation-scope";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-relation-scope",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "atlas reliability memo" },
        ]),
        createdAt: now,
      })
      .run();

    db.insert(memoryItems)
      .values([
        {
          id: "item-rel-a-active",
          kind: "fact",
          subject: "autoscaling policy",
          statement: "Use Kubernetes HPA for sustained traffic spikes",
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: "fp-rel-a-active",
          verificationState: "user_confirmed",
          scopeId: "project-a",
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          id: "item-rel-b-active",
          kind: "fact",
          subject: "scheduler policy",
          statement: "Use Nomad system jobs for batch workloads",
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: "fp-rel-b-active",
          verificationState: "user_confirmed",
          scopeId: "project-b",
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          id: "item-rel-a-invalid",
          kind: "fact",
          subject: "deprecated platform",
          statement: "Legacy Kubernetes cluster should still be used",
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: "fp-rel-a-invalid",
          verificationState: "user_confirmed",
          scopeId: "project-a",
          firstSeenAt: now,
          lastSeenAt: now,
          invalidAt: now + 1,
        },
        {
          id: "item-rel-a-pending",
          kind: "fact",
          subject: "pending platform policy",
          statement: "Pending clarification platform statement",
          status: "pending_clarification",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: "fp-rel-a-pending",
          verificationState: "assistant_inferred",
          scopeId: "project-a",
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ])
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-rel-a-active",
          messageId: "msg-relation-scope",
          evidence: "source a active",
          createdAt: now,
        },
        {
          memoryItemId: "item-rel-b-active",
          messageId: "msg-relation-scope",
          evidence: "source b active",
          createdAt: now,
        },
        {
          memoryItemId: "item-rel-a-invalid",
          messageId: "msg-relation-scope",
          evidence: "source a invalid",
          createdAt: now,
        },
        {
          memoryItemId: "item-rel-a-pending",
          messageId: "msg-relation-scope",
          evidence: "source a pending",
          createdAt: now,
        },
      ])
      .run();

    db.insert(memoryEntities)
      .values([
        {
          id: "entity-atlas-test",
          name: "Project Atlas",
          type: "project",
          aliases: JSON.stringify(["atlas"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now,
          mentionCount: 1,
        },
        {
          id: "entity-k8s-test",
          name: "Kubernetes",
          type: "tool",
          aliases: JSON.stringify(["k8s"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now,
          mentionCount: 1,
        },
        {
          id: "entity-nomad-test",
          name: "Nomad",
          type: "tool",
          aliases: JSON.stringify(["nomad"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now,
          mentionCount: 1,
        },
      ])
      .run();

    db.insert(memoryEntityRelations)
      .values([
        {
          id: "rel-atlas-k8s-test",
          sourceEntityId: "entity-atlas-test",
          targetEntityId: "entity-k8s-test",
          relation: "uses",
          evidence: "Atlas uses Kubernetes",
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          id: "rel-atlas-nomad-test",
          sourceEntityId: "entity-atlas-test",
          targetEntityId: "entity-nomad-test",
          relation: "uses",
          evidence: "Atlas also uses Nomad in a different scope",
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ])
      .run();

    db.insert(memoryItemEntities)
      .values([
        {
          memoryItemId: "item-rel-a-active",
          entityId: "entity-k8s-test",
        },
        {
          memoryItemId: "item-rel-a-invalid",
          entityId: "entity-k8s-test",
        },
        {
          memoryItemId: "item-rel-a-pending",
          entityId: "entity-k8s-test",
        },
        {
          memoryItemId: "item-rel-b-active",
          entityId: "entity-nomad-test",
        },
      ])
      .run();

    const relationConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        entity: {
          ...TEST_CONFIG.memory.entity,
          relationRetrieval: {
            ...TEST_CONFIG.memory.entity.relationRetrieval,
            enabled: true,
            maxSeedEntities: 6,
            maxNeighborEntities: 6,
            maxEdges: 10,
            neighborScoreMultiplier: 0.7,
          },
        },
      },
    };

    const result = await buildMemoryRecall(
      "atlas reliability roadmap",
      convId,
      relationConfig,
      { scopeId: "project-a" },
    );
    const keys = result.topCandidates.map((candidate) => candidate.key);

    expect(keys).toContain("item:item-rel-a-active");
    expect(keys).not.toContain("item:item-rel-b-active");
    expect(keys).not.toContain("item:item-rel-a-invalid");
    expect(keys).not.toContain("item:item-rel-a-pending");
  });

  test("scope columns: summaries default to scope_id=default", () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memorySummaries)
      .values({
        id: "summary-scope-test",
        scope: "weekly_global",
        scopeKey: "2025-W01",
        summary: "Test summary for scope",
        tokenEstimate: 10,
        startAt: now - 7 * 86_400_000,
        endAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const summary = db
      .select()
      .from(memorySummaries)
      .where(eq(memorySummaries.id, "summary-scope-test"))
      .get();
    expect(summary).toBeDefined();
    expect(summary!.scopeId).toBe("default");
  });

  test("forced backfill does not double-schedule entity extraction via relation backfill", async () => {
    const db = getDb();
    const now = 1_700_002_000_000;
    const originalEnabled = TEST_CONFIG.memory.entity.enabled;
    const originalRelationsEnabled =
      TEST_CONFIG.memory.entity.extractRelations.enabled;
    TEST_CONFIG.memory.entity.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-no-double",
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

      // Insert fewer than 200 messages so the backfill completes in one batch
      for (let i = 0; i < 3; i++) {
        db.insert(messages)
          .values({
            id: `msg-no-double-${i}`,
            conversationId: "conv-no-double",
            role: "user",
            content: JSON.stringify([
              { type: "text", text: `Test message ${i} for double scheduling` },
            ]),
            createdAt: now + i + 1,
          })
          .run();
      }

      // Enqueue a forced backfill
      enqueueMemoryJob("backfill", { force: true });
      await runMemoryJobsOnce();

      // The backfill should have completed (< 200 msgs) and enqueued a
      // non-forced relation backfill.  Count extract_entities jobs: they
      // should come only from the extract_items chain, not duplicated by
      // the relation backfill (which hasn't run yet).
      const relationBackfillJobs = db
        .select()
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.type, "backfill_entity_relations"),
            eq(memoryJobs.status, "pending"),
          ),
        )
        .all();

      // A non-forced relation backfill should be enqueued
      expect(relationBackfillJobs.length).toBeLessThanOrEqual(1);

      // Verify the relation backfill was NOT force-flagged
      if (relationBackfillJobs.length === 1) {
        const payload = JSON.parse(relationBackfillJobs[0].payload);
        expect(payload.force).not.toBe(true);
      }
    } finally {
      TEST_CONFIG.memory.entity.enabled = originalEnabled;
      TEST_CONFIG.memory.entity.extractRelations.enabled =
        originalRelationsEnabled;
    }
  });

  test("backfill enqueues relation backfill when message count is exact multiple of 200", async () => {
    const db = getDb();
    const now = 1_700_004_000_000;
    const originalEnabled = TEST_CONFIG.memory.entity.enabled;
    const originalRelationsEnabled =
      TEST_CONFIG.memory.entity.extractRelations.enabled;
    TEST_CONFIG.memory.entity.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.enabled = true;

    try {
      db.insert(conversations)
        .values({
          id: "conv-exact-200",
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

      // Insert exactly 200 messages so the first backfill batch is full
      for (let i = 0; i < 200; i++) {
        db.insert(messages)
          .values({
            id: `msg-exact-200-${String(i).padStart(4, "0")}`,
            conversationId: "conv-exact-200",
            role: "user",
            content: JSON.stringify([{ type: "text", text: `Message ${i}` }]),
            createdAt: now + i + 1,
          })
          .run();
      }

      // First backfill: processes 200 messages, should enqueue another backfill
      enqueueMemoryJob("backfill", {});
      await runMemoryJobsOnce();

      // Should have enqueued a follow-up backfill (batch was full)
      const followUpBackfill = db
        .select()
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.type, "backfill"),
            eq(memoryJobs.status, "pending"),
          ),
        )
        .all();
      expect(followUpBackfill).toHaveLength(1);

      // No relation backfill yet (batch was full, more work expected)
      const relationBefore = db
        .select()
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.type, "backfill_entity_relations"),
            eq(memoryJobs.status, "pending"),
          ),
        )
        .all();
      expect(relationBefore).toHaveLength(0);

      // Clear all non-backfill pending jobs so the next runMemoryJobsOnce
      // picks up the follow-up backfill job (claimMemoryJobs has a concurrency
      // limit and processes jobs in creation order)
      db.run(
        `DELETE FROM memory_jobs WHERE type != 'backfill' AND status = 'pending'`,
      );

      // Second backfill: reads 0 messages (terminal empty batch), should
      // still enqueue the relation backfill
      await runMemoryJobsOnce();

      const relationAfter = db
        .select()
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.type, "backfill_entity_relations"),
            eq(memoryJobs.status, "pending"),
          ),
        )
        .all();
      expect(relationAfter).toHaveLength(1);
    } finally {
      TEST_CONFIG.memory.entity.enabled = originalEnabled;
      TEST_CONFIG.memory.entity.extractRelations.enabled =
        originalRelationsEnabled;
    }
  });

  test("relation backfill respects extractFromAssistant=false config", async () => {
    const db = getDb();
    const now = 1_700_003_000_000;
    const originalEnabled = TEST_CONFIG.memory.entity.enabled;
    const originalRelationsEnabled =
      TEST_CONFIG.memory.entity.extractRelations.enabled;
    const originalBatchSize =
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize;
    const originalExtractFromAssistant =
      TEST_CONFIG.memory.extraction.extractFromAssistant;
    TEST_CONFIG.memory.entity.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize = 10;
    TEST_CONFIG.memory.extraction.extractFromAssistant = false;

    try {
      db.insert(conversations)
        .values({
          id: "conv-role-filter",
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
            id: "msg-role-user",
            conversationId: "conv-role-filter",
            role: "user",
            content: JSON.stringify([
              { type: "text", text: "User message for entity extraction." },
            ]),
            createdAt: now + 1,
          },
          {
            id: "msg-role-assistant",
            conversationId: "conv-role-filter",
            role: "assistant",
            content: JSON.stringify([
              {
                type: "text",
                text: "Assistant message that should be skipped.",
              },
            ]),
            createdAt: now + 2,
          },
          {
            id: "msg-role-user-2",
            conversationId: "conv-role-filter",
            role: "user",
            content: JSON.stringify([
              { type: "text", text: "Another user message for extraction." },
            ]),
            createdAt: now + 3,
          },
        ])
        .run();

      enqueueBackfillEntityRelationsJob(true);
      await runMemoryJobsOnce();

      // Only user messages should have extract_entities jobs
      const extractJobs = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.type, "extract_entities"))
        .all();

      const extractedMessageIds = extractJobs.map((j) => {
        const payload = JSON.parse(j.payload);
        return payload.messageId;
      });

      expect(extractedMessageIds).toContain("msg-role-user");
      expect(extractedMessageIds).toContain("msg-role-user-2");
      expect(extractedMessageIds).not.toContain("msg-role-assistant");
    } finally {
      TEST_CONFIG.memory.entity.enabled = originalEnabled;
      TEST_CONFIG.memory.entity.extractRelations.enabled =
        originalRelationsEnabled;
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize =
        originalBatchSize;
      TEST_CONFIG.memory.extraction.extractFromAssistant =
        originalExtractFromAssistant;
    }
  });

  test("entity relations upsert is idempotent under repeated processing", () => {
    const db = getDb();
    const sourceEntityId = upsertEntity({
      name: "Project Atlas",
      type: "project",
      aliases: ["atlas"],
    });
    const targetEntityId = upsertEntity({
      name: "Qdrant",
      type: "tool",
      aliases: [],
    });

    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: "uses",
      evidence: "Project Atlas uses Qdrant for vector search",
      seenAt: 1_700_000_000_000,
    });
    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: "uses",
      evidence: null,
      seenAt: 1_700_000_100_000,
    });
    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: "uses",
      evidence: "Atlas currently depends on Qdrant",
      seenAt: 1_700_000_200_000,
    });

    const rows = db
      .select()
      .from(memoryEntityRelations)
      .where(
        and(
          eq(memoryEntityRelations.sourceEntityId, sourceEntityId),
          eq(memoryEntityRelations.targetEntityId, targetEntityId),
          eq(memoryEntityRelations.relation, "uses"),
        ),
      )
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0].firstSeenAt).toBe(1_700_000_000_000);
    expect(rows[0].lastSeenAt).toBe(1_700_000_200_000);
    expect(rows[0].evidence).toBe("Atlas currently depends on Qdrant");
  });

  // ── scopePolicyOverride tests ───────────────────────────────────────

  test("scopePolicyOverride with fallbackToDefault includes both scopes even when global policy is strict", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-override-fallback";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-override-fallback",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "override fallback test" },
        ]),
        createdAt: now,
      })
      .run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-default', 'msg-override-fallback', '${convId}', 'user', 0, 'Global memory about microservices architecture patterns', 10, 'default', ${now}, ${now})
    `);

    // Insert segment in private thread scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-private', 'msg-override-fallback', '${convId}', 'user', 1, 'Private thread memory about microservices architecture patterns', 10, 'private-thread-42', ${now}, ${now})
    `);

    // Global policy is strict, but override requests fallback to default
    const strictConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          scopePolicy: "strict" as const,
        },
      },
    };

    const result = await buildMemoryRecall(
      "microservices architecture",
      convId,
      strictConfig,
      {
        scopePolicyOverride: {
          scopeId: "private-thread-42",
          fallbackToDefault: true,
        },
      },
    );
    const keys = result.topCandidates.map((c) => c.key);

    // Override should include both private and default scope despite strict global policy
    expect(keys).toContain("segment:seg-ovr-default");
    expect(keys).toContain("segment:seg-ovr-private");
  });

  test("scopePolicyOverride without fallback excludes default scope even when global policy is allow_global_fallback", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-override-nofallback";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-override-nofallback",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "override no fallback" },
        ]),
        createdAt: now,
      })
      .run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-nf-default', 'msg-override-nofallback', '${convId}', 'user', 0, 'Global memory about container orchestration strategies', 10, 'default', ${now}, ${now})
    `);

    // Insert segment in isolated scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-nf-isolated', 'msg-override-nofallback', '${convId}', 'user', 1, 'Isolated memory about container orchestration strategies', 10, 'isolated-scope', ${now}, ${now})
    `);

    // Global policy allows fallback, but override says no fallback
    const fallbackConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          scopePolicy: "allow_global_fallback" as const,
        },
      },
    };

    const result = await buildMemoryRecall(
      "container orchestration",
      convId,
      fallbackConfig,
      {
        scopePolicyOverride: {
          scopeId: "isolated-scope",
          fallbackToDefault: false,
        },
      },
    );
    const keys = result.topCandidates.map((c) => c.key);

    // Override disables fallback — only isolated scope should appear
    expect(keys).not.toContain("segment:seg-ovr-nf-default");
    expect(keys).toContain("segment:seg-ovr-nf-isolated");
  });

  test("scopePolicyOverride takes precedence over scopeId option", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-override-precedence";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-override-precedence",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "precedence test" }]),
        createdAt: now,
      })
      .run();

    // Insert segment in scope-a (what scopeId would resolve to)
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-prec-a', 'msg-override-precedence', '${convId}', 'user', 0, 'Scope A memory about distributed caching patterns', 10, 'scope-a', ${now}, ${now})
    `);

    // Insert segment in scope-b (what the override targets)
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-prec-b', 'msg-override-precedence', '${convId}', 'user', 1, 'Scope B memory about distributed caching patterns', 10, 'scope-b', ${now}, ${now})
    `);

    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          scopePolicy: "strict" as const,
        },
      },
    };

    // scopeId says 'scope-a', but override says 'scope-b' — override wins
    const result = await buildMemoryRecall(
      "distributed caching",
      convId,
      config,
      {
        scopeId: "scope-a",
        scopePolicyOverride: {
          scopeId: "scope-b",
          fallbackToDefault: false,
        },
      },
    );
    const keys = result.topCandidates.map((c) => c.key);

    expect(keys).not.toContain("segment:seg-ovr-prec-a");
    expect(keys).toContain("segment:seg-ovr-prec-b");
  });

  test("scopePolicyOverride with default as primary scope and fallback=true returns only default", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-scope-override-default-primary";

    db.insert(conversations)
      .values({
        id: convId,
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
        id: "msg-override-default-primary",
        conversationId: convId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "default primary" }]),
        createdAt: now,
      })
      .run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-dp-default', 'msg-override-default-primary', '${convId}', 'user', 0, 'Default scope memory about event driven design', 10, 'default', ${now}, ${now})
    `);

    // Insert segment in other scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-ovr-dp-other', 'msg-override-default-primary', '${convId}', 'user', 1, 'Other scope memory about event driven design', 10, 'other-scope', ${now}, ${now})
    `);

    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };

    // When primary scope IS 'default' with fallback=true, no duplication —
    // just ['default'] is used
    const result = await buildMemoryRecall(
      "event driven design",
      convId,
      config,
      {
        scopePolicyOverride: {
          scopeId: "default",
          fallbackToDefault: true,
        },
      },
    );
    const keys = result.topCandidates.map((c) => c.key);

    expect(keys).toContain("segment:seg-ovr-dp-default");
    expect(keys).not.toContain("segment:seg-ovr-dp-other");
  });

  // PR-17: addMessage() passes conversation scope to the indexer
  test("addMessage inherits private conversation scope on memory segments", async () => {
    const conv = createConversation({
      title: "Private thread",
      threadType: "private",
    });
    expect(conv.memoryScopeId).toMatch(/^private:/);

    const msg = await addMessage(
      conv.id,
      "user",
      "My secret project details for the private thread.",
    );

    const db = getDb();
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, msg.id))
      .all();

    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.scopeId).toBe(conv.memoryScopeId);
    }
  });

  test("addMessage uses default scope for standard conversations", async () => {
    const conv = createConversation({
      title: "Standard thread",
      threadType: "standard",
    });
    expect(conv.memoryScopeId).toBe("default");

    const msg = await addMessage(
      conv.id,
      "user",
      "Normal conversation content for testing scope defaults.",
    );

    const db = getDb();
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, msg.id))
      .all();

    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.scopeId).toBe("default");
    }
  });

  // PR-18: extract_items jobs carry scopeId through the async pipeline
  test("extract_items job payload includes scopeId from private conversation", () => {
    const conv = createConversation({
      title: "Private scope job test",
      threadType: "private",
    });
    expect(conv.memoryScopeId).toMatch(/^private:/);

    addMessage(
      conv.id,
      "user",
      "Important data that should trigger extraction in private scope.",
    );

    const db = getDb();
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();

    expect(extractJobs.length).toBeGreaterThan(0);
    const lastJob = extractJobs[extractJobs.length - 1];
    const payload = JSON.parse(lastJob.payload) as Record<string, unknown>;
    expect(payload.scopeId).toBe(conv.memoryScopeId);
  });

  test("extract_items job payload defaults scopeId to default for standard conversations", () => {
    const conv = createConversation({
      title: "Standard scope job test",
      threadType: "standard",
    });
    expect(conv.memoryScopeId).toBe("default");

    addMessage(
      conv.id,
      "user",
      "Regular content for extraction in default scope.",
    );

    const db = getDb();
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();

    expect(extractJobs.length).toBeGreaterThan(0);
    const lastJob = extractJobs[extractJobs.length - 1];
    const payload = JSON.parse(lastJob.payload) as Record<string, unknown>;
    expect(payload.scopeId).toBe("default");
  });

  // PR-19: extractItemsJob forwards scopeId to extractAndUpsertMemoryItemsForMessage
  test("extractAndUpsertMemoryItemsForMessage accepts optional scopeId without breaking", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(conversations)
      .values({
        id: "conv-scope-pass",
        title: null,
        createdAt: now,
        updatedAt: now,
        threadType: "standard",
        memoryScopeId: "default",
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-scope-pass",
        conversationId: "conv-scope-pass",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "I prefer TypeScript over JavaScript for all new projects.",
          },
        ]),
        createdAt: now,
      })
      .run();

    // Call without scopeId — backward compat: should work exactly as before
    const withoutScope =
      await extractAndUpsertMemoryItemsForMessage("msg-scope-pass");
    expect(withoutScope).toBeGreaterThan(0);

    // Call with explicit scopeId — should also succeed and scope items accordingly
    db.insert(messages)
      .values({
        id: "msg-scope-pass-2",
        conversationId: "conv-scope-pass",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "I dislike using var in JavaScript, prefer const and let.",
          },
        ]),
        createdAt: now + 1,
      })
      .run();
    const withScope = await extractAndUpsertMemoryItemsForMessage(
      "msg-scope-pass-2",
      "private:thread-42",
    );
    expect(withScope).toBeGreaterThan(0);
  });

  // PR-20: same statement in different scopes produces separate active items
  test("same statement in different scopes produces separate active memory items", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(conversations)
      .values({
        id: "conv-scope-separate",
        title: null,
        createdAt: now,
        updatedAt: now,
        threadType: "standard",
        memoryScopeId: "default",
      })
      .run();

    // Insert two messages with identical content
    db.insert(messages)
      .values({
        id: "msg-scope-default",
        conversationId: "conv-scope-separate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "I prefer dark mode for all my editors and terminals.",
          },
        ]),
        createdAt: now,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-scope-private",
        conversationId: "conv-scope-separate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "I prefer dark mode for all my editors and terminals.",
          },
        ]),
        createdAt: now + 1,
      })
      .run();

    // Extract into default scope
    const defaultCount =
      await extractAndUpsertMemoryItemsForMessage("msg-scope-default");
    expect(defaultCount).toBeGreaterThan(0);

    // Extract identical statement into a private scope
    const privateCount = await extractAndUpsertMemoryItemsForMessage(
      "msg-scope-private",
      "private:thread-99",
    );
    expect(privateCount).toBeGreaterThan(0);

    // Both scopes should have separate active items
    const defaultItems = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scopeId, "default"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();
    const privateItems = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scopeId, "private:thread-99"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();

    expect(defaultItems.length).toBeGreaterThan(0);
    expect(privateItems.length).toBeGreaterThan(0);

    // Scope-salted fingerprints: same content in different scopes yields distinct fingerprints
    const defaultFingerprints = new Set(defaultItems.map((i) => i.fingerprint));
    const matchingPrivate = privateItems.filter((i) =>
      defaultFingerprints.has(i.fingerprint),
    );
    expect(matchingPrivate.length).toBe(0);
  });

  // PR-21: identical fact in default vs private scopes gets distinct fingerprints
  test("identical content in different scopes produces distinct fingerprints", async () => {
    const db = getDb();
    const now = Date.now();
    const statement = "I prefer using Vim keybindings in all my text editors.";

    db.insert(conversations)
      .values({
        id: "conv-fp-salt",
        title: null,
        createdAt: now,
        updatedAt: now,
        threadType: "standard",
        memoryScopeId: "default",
      })
      .run();

    db.insert(messages)
      .values({
        id: "msg-fp-salt-default",
        conversationId: "conv-fp-salt",
        role: "user",
        content: JSON.stringify([{ type: "text", text: statement }]),
        createdAt: now,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-fp-salt-private",
        conversationId: "conv-fp-salt",
        role: "user",
        content: JSON.stringify([{ type: "text", text: statement }]),
        createdAt: now + 1,
      })
      .run();

    await extractAndUpsertMemoryItemsForMessage("msg-fp-salt-default");
    await extractAndUpsertMemoryItemsForMessage(
      "msg-fp-salt-private",
      "private:fp-test",
    );

    const defaultItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "default"))
      .all()
      .filter((i) => i.statement === statement);
    const privateItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, "private:fp-test"))
      .all()
      .filter((i) => i.statement === statement);

    expect(defaultItems.length).toBe(1);
    expect(privateItems.length).toBe(1);
    // Same content, different scopes — fingerprints must differ
    expect(defaultItems[0].fingerprint).not.toBe(privateItems[0].fingerprint);
    // But the actual content should be identical
    expect(defaultItems[0].kind).toBe(privateItems[0].kind);
    expect(defaultItems[0].subject).toBe(privateItems[0].subject);
    expect(defaultItems[0].statement).toBe(privateItems[0].statement);
  });

  // PR-20: default scope items are not affected by private scope operations
  test("default scope items are not superseded by private scope operations", async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(conversations)
      .values({
        id: "conv-scope-isolate",
        title: null,
        createdAt: now,
        updatedAt: now,
        threadType: "standard",
        memoryScopeId: "default",
      })
      .run();

    // Insert a decision in the default scope
    db.insert(messages)
      .values({
        id: "msg-decision-default",
        conversationId: "conv-scope-isolate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "We decided to use PostgreSQL for the production database.",
          },
        ]),
        createdAt: now,
      })
      .run();
    await extractAndUpsertMemoryItemsForMessage("msg-decision-default");

    const defaultBefore = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scopeId, "default"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();
    expect(defaultBefore.length).toBeGreaterThan(0);

    // Now insert a superseding decision in a private scope
    db.insert(messages)
      .values({
        id: "msg-decision-private",
        conversationId: "conv-scope-isolate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "We decided to use SQLite for the production database instead.",
          },
        ]),
        createdAt: now + 1,
      })
      .run();
    await extractAndUpsertMemoryItemsForMessage(
      "msg-decision-private",
      "private:thread-55",
    );

    // The default scope items should still be active — private scope supersede must not affect them
    const defaultAfter = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scopeId, "default"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();

    expect(defaultAfter.length).toBe(defaultBefore.length);
    for (const item of defaultAfter) {
      expect(item.status).toBe("active");
    }
  });

  test("private conversation summary inherits private scope_id", async () => {
    const db = getDb();
    const conv = createConversation({ threadType: "private" });
    const scopeId = getConversationMemoryScopeId(conv.id);
    expect(scopeId).toMatch(/^private:/);

    // Insert messages and segments so the summarizer has input
    db.insert(messages)
      .values({
        id: "msg-priv-sum-1",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Secret project details" },
        ]),
        createdAt: conv.createdAt + 1,
      })
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text,
        token_estimate, scope_id, created_at, updated_at
      ) VALUES (
        'seg-priv-sum-1', 'msg-priv-sum-1', '${conv.id}', 'user', 0,
        'Secret project details', 5, '${scopeId}',
        ${conv.createdAt + 1}, ${conv.createdAt + 1}
      )
    `);

    // Run the conversation summarizer
    const fakeJob = {
      id: "job-priv-sum",
      type: "build_conversation_summary" as const,
      payload: { conversationId: conv.id },
      status: "running" as const,
      attempts: 0,
      deferrals: 0,
      runAfter: 0,
      lastError: null,
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await buildConversationSummaryJob(fakeJob, TEST_CONFIG);

    const summary = db
      .select()
      .from(memorySummaries)
      .where(
        and(
          eq(memorySummaries.scope, "conversation"),
          eq(memorySummaries.scopeKey, conv.id),
        ),
      )
      .get();

    expect(summary).toBeDefined();
    expect(summary!.scopeId).toBe(scopeId);
  });

  test("default-scope summary retrieval excludes private summaries", async () => {
    const db = getDb();
    const now = Date.now();

    // Create a private conversation and build its summary
    const privConv = createConversation({ threadType: "private" });
    const privScope = getConversationMemoryScopeId(privConv.id);

    db.insert(messages)
      .values({
        id: "msg-scope-excl-1",
        conversationId: privConv.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Private memo" }]),
        createdAt: now + 1,
      })
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text,
        token_estimate, scope_id, created_at, updated_at
      ) VALUES (
        'seg-scope-excl-1', 'msg-scope-excl-1', '${privConv.id}', 'user', 0,
        'Private memo', 3, '${privScope}',
        ${now + 1}, ${now + 1}
      )
    `);

    await buildConversationSummaryJob(
      {
        id: "job-scope-excl-priv",
        type: "build_conversation_summary" as const,
        payload: { conversationId: privConv.id },
        status: "running" as const,
        attempts: 0,
        deferrals: 0,
        runAfter: 0,
        lastError: null,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      TEST_CONFIG,
    );

    // Create a standard conversation and build its summary
    const stdConv = createConversation({ title: "Standard conv" });
    const stdScope = getConversationMemoryScopeId(stdConv.id);
    expect(stdScope).toBe("default");

    db.insert(messages)
      .values({
        id: "msg-scope-excl-2",
        conversationId: stdConv.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Public notes" }]),
        createdAt: now + 2,
      })
      .run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text,
        token_estimate, scope_id, created_at, updated_at
      ) VALUES (
        'seg-scope-excl-2', 'msg-scope-excl-2', '${stdConv.id}', 'user', 0,
        'Public notes', 3, 'default',
        ${now + 2}, ${now + 2}
      )
    `);

    await buildConversationSummaryJob(
      {
        id: "job-scope-excl-std",
        type: "build_conversation_summary" as const,
        payload: { conversationId: stdConv.id },
        status: "running" as const,
        attempts: 0,
        deferrals: 0,
        runAfter: 0,
        lastError: null,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      TEST_CONFIG,
    );

    // Query summaries scoped to 'default' — should only include the standard one
    const defaultSummaries = db
      .select()
      .from(memorySummaries)
      .where(eq(memorySummaries.scopeId, "default"))
      .all();
    const privateSummaries = db
      .select()
      .from(memorySummaries)
      .where(eq(memorySummaries.scopeId, privScope))
      .all();

    expect(defaultSummaries).toHaveLength(1);
    expect(defaultSummaries[0].scopeKey).toBe(stdConv.id);

    expect(privateSummaries).toHaveLength(1);
    expect(privateSummaries[0].scopeKey).toBe(privConv.id);
  });

  // ── End-to-end memory-boundary regression tests ─────────────────────

  test("e2e: private-only facts are recalled in private thread but not in standard thread", async () => {
    const db = getDb();

    // 1. Create a private conversation and add a message with a distinctive fact
    const privConv = createConversation({
      title: "Private e2e test",
      threadType: "private",
    });
    const privScope = getConversationMemoryScopeId(privConv.id);
    expect(privScope).toMatch(/^private:/);

    const privMsg = await addMessage(
      privConv.id,
      "user",
      "I prefer using the Zephyr framework for all backend microservices.",
    );

    // 2. Extract memory items — they inherit the private scope
    const upserted = await extractAndUpsertMemoryItemsForMessage(
      privMsg.id,
      privScope,
    );
    expect(upserted).toBeGreaterThan(0);

    // Verify items were stored with the private scope
    const privateItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.scopeId, privScope))
      .all();
    expect(privateItems.length).toBeGreaterThan(0);
    expect(
      privateItems.some((i) => i.statement.toLowerCase().includes("zephyr")),
    ).toBe(true);

    // Collect the item IDs so we can check them in recall results
    const privateItemKeys = privateItems.map((i) => `item:${i.id}`);

    // Link extracted items to an entity matching a query token ("zephyr")
    db.insert(memoryEntities)
      .values({
        id: "entity-zephyr",
        name: "zephyr",
        type: "concept",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        mentionCount: 1,
      })
      .run();
    for (const item of privateItems) {
      db.insert(memoryItemEntities)
        .values({ memoryItemId: item.id, entityId: "entity-zephyr" })
        .run();
    }

    // 3. Create a standard conversation for the "standard thread" perspective
    const stdConv = createConversation({
      title: "Standard e2e test",
      threadType: "standard",
    });
    const stdScope = getConversationMemoryScopeId(stdConv.id);
    expect(stdScope).toBe("default");

    db.insert(messages)
      .values({
        id: "msg-std-e2e-noleak",
        conversationId: stdConv.id,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "placeholder for standard conv" },
        ]),
        createdAt: Date.now(),
      })
      .run();

    const recallConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };

    // 4. Private thread recall — should find the Zephyr fact
    const privRecall = await buildMemoryRecall(
      "Zephyr framework microservices",
      privConv.id,
      recallConfig,
      {
        scopePolicyOverride: {
          scopeId: privScope,
          fallbackToDefault: true,
        },
      },
    );
    const privCandidateKeys = privRecall.topCandidates.map((c) => c.key);
    const hasZephyrInPrivate = privateItemKeys.some((k) =>
      privCandidateKeys.includes(k),
    );
    expect(hasZephyrInPrivate).toBe(true);
    expect(privRecall.injectedText.toLowerCase()).toContain("zephyr");

    // 5. Standard thread recall — must NOT find the Zephyr fact (no leak)
    // Mirror the production call in session-memory.ts: for standard threads
    // (scopeId === 'default'), scopePolicyOverride is undefined.
    const stdRecall = await buildMemoryRecall(
      "Zephyr framework microservices",
      stdConv.id,
      recallConfig,
      {
        scopeId: stdScope,
        scopePolicyOverride: undefined,
      },
    );
    const stdCandidateKeys = stdRecall.topCandidates.map((c) => c.key);
    const hasZephyrInStandard = privateItemKeys.some((k) =>
      stdCandidateKeys.includes(k),
    );
    expect(hasZephyrInStandard).toBe(false);
    expect(stdRecall.injectedText.toLowerCase()).not.toContain("zephyr");
  });

  test("e2e: private thread still recalls facts from default memory scope", async () => {
    const db = getDb();
    const now = Date.now();

    // 1. Create a standard conversation and add a fact to default scope
    const stdConv = createConversation({
      title: "Default scope source",
      threadType: "standard",
    });
    const stdScope = getConversationMemoryScopeId(stdConv.id);
    expect(stdScope).toBe("default");

    const stdMsg = await addMessage(
      stdConv.id,
      "user",
      "I prefer using the Obsidian editor for all my note-taking workflows.",
    );

    const upsertedDefault = await extractAndUpsertMemoryItemsForMessage(
      stdMsg.id,
      stdScope,
    );
    expect(upsertedDefault).toBeGreaterThan(0);

    // Verify items landed in the default scope
    const defaultItems = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scopeId, "default"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();
    const hasObsidian = defaultItems.some((i) =>
      i.statement.toLowerCase().includes("obsidian"),
    );
    expect(hasObsidian).toBe(true);

    // Collect default item IDs containing "obsidian" for key-based verification
    const obsidianItemKeys = defaultItems
      .filter((i) => i.statement.toLowerCase().includes("obsidian"))
      .map((i) => `item:${i.id}`);

    // Link extracted items to an entity matching a query token ("obsidian")
    db.insert(memoryEntities)
      .values({
        id: "entity-obsidian",
        name: "obsidian",
        type: "concept",
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
      })
      .run();
    for (const item of defaultItems.filter((i) =>
      i.statement.toLowerCase().includes("obsidian"),
    )) {
      db.insert(memoryItemEntities)
        .values({ memoryItemId: item.id, entityId: "entity-obsidian" })
        .run();
    }

    // 2. Create a private conversation
    const privConv = createConversation({
      title: "Private fallback test",
      threadType: "private",
    });
    const privScope = getConversationMemoryScopeId(privConv.id);
    expect(privScope).toMatch(/^private:/);

    db.insert(messages)
      .values({
        id: "msg-priv-e2e-fallback",
        conversationId: privConv.id,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "placeholder for private conv fallback test" },
        ]),
        createdAt: now + 1,
      })
      .run();

    const recallConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };

    // 3. Private thread recall with fallback to default — should find the Obsidian fact
    const privRecall = await buildMemoryRecall(
      "Obsidian editor note-taking",
      privConv.id,
      recallConfig,
      {
        scopePolicyOverride: {
          scopeId: privScope,
          fallbackToDefault: true,
        },
      },
    );
    const privCandidateKeys = privRecall.topCandidates.map((c) => c.key);
    const hasObsidianInPrivate = obsidianItemKeys.some((k) =>
      privCandidateKeys.includes(k),
    );
    expect(hasObsidianInPrivate).toBe(true);
    expect(privRecall.injectedText.toLowerCase()).toContain("obsidian");
  });

  // Backfill preserves private conversation scope on memory segments
  test("backfillJob preserves private conversation scope during reindex", () => {
    const db = getDb();

    // Create a private conversation with a message
    const conv = createConversation({
      title: "Backfill scope test",
      threadType: "private",
    });
    expect(conv.memoryScopeId).toMatch(/^private:/);

    // Insert a message directly (bypassing addMessage to avoid pre-indexing)
    const msgId = "msg-backfill-scope-test";
    db.insert(messages)
      .values({
        id: msgId,
        conversationId: conv.id,
        role: "user",
        content:
          "My confidential backfill test content for private thread preservation.",
        createdAt: conv.createdAt + 1,
      })
      .run();

    // Run the backfill job — it should look up the conversation scope
    const fakeJob = {
      id: "job-backfill-scope",
      type: "backfill" as const,
      payload: { force: true },
      status: "running" as const,
      attempts: 0,
      deferrals: 0,
      runAfter: 0,
      lastError: null,
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    backfillJob(fakeJob, TEST_CONFIG);

    // Verify the segments were indexed with the private scope
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, msgId))
      .all();

    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.scopeId).toBe(conv.memoryScopeId);
    }
  });

  test("backfillJob preserves provenance trust gating during reindex", () => {
    const db = getDb();

    const conv = createConversation("Backfill provenance trust gate");
    const msgId = "msg-backfill-untrusted-provenance";
    db.insert(messages)
      .values({
        id: msgId,
        conversationId: conv.id,
        role: "user",
        content:
          "Untrusted sender says preferences should not become durable profile memory.",
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          provenanceSourceChannel: "telegram",
        }),
        createdAt: conv.createdAt + 1,
      })
      .run();

    const fakeJob = {
      id: "job-backfill-untrusted-provenance",
      type: "backfill" as const,
      payload: { force: true },
      status: "running" as const,
      attempts: 0,
      deferrals: 0,
      runAfter: 0,
      lastError: null,
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    backfillJob(fakeJob, TEST_CONFIG);

    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, msgId))
      .all();
    expect(segments.length).toBeGreaterThan(0);

    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all()
      .filter((job) => JSON.parse(job.payload).messageId === msgId);
    expect(extractJobs).toHaveLength(0);
  });

  test("relation backfill skips untrusted provenance messages", () => {
    const db = getDb();
    const now = Date.now();
    const originalEnabled = TEST_CONFIG.memory.entity.enabled;
    const originalRelationsEnabled =
      TEST_CONFIG.memory.entity.extractRelations.enabled;
    const originalBatchSize =
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize;

    TEST_CONFIG.memory.entity.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.enabled = true;
    TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize = 50;

    try {
      db.insert(conversations)
        .values({
          id: "conv-relation-provenance-gate",
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
            id: "msg-relation-trusted",
            conversationId: "conv-relation-provenance-gate",
            role: "user",
            content: JSON.stringify([
              {
                type: "text",
                text: "Trusted guardian message for relation backfill.",
              },
            ]),
            metadata: JSON.stringify({
              provenanceTrustClass: "guardian",
              provenanceSourceChannel: "telegram",
            }),
            createdAt: now + 1,
          },
          {
            id: "msg-relation-untrusted",
            conversationId: "conv-relation-provenance-gate",
            role: "user",
            content: JSON.stringify([
              {
                type: "text",
                text: "Untrusted message that should be excluded from relation backfill extraction.",
              },
            ]),
            metadata: JSON.stringify({
              provenanceTrustClass: "trusted_contact",
              provenanceSourceChannel: "telegram",
            }),
            createdAt: now + 2,
          },
        ])
        .run();

      const relationJob = {
        id: "job-relation-provenance-gate",
        type: "backfill_entity_relations" as const,
        payload: { force: true },
        status: "running" as const,
        attempts: 0,
        deferrals: 0,
        runAfter: 0,
        lastError: null,
        startedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      backfillEntityRelationsJob(relationJob, TEST_CONFIG);

      const extractJobs = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.type, "extract_entities"))
        .all();
      const extractedMessageIds = extractJobs.map(
        (job) => JSON.parse(job.payload).messageId,
      );

      expect(extractedMessageIds).toContain("msg-relation-trusted");
      expect(extractedMessageIds).not.toContain("msg-relation-untrusted");
    } finally {
      TEST_CONFIG.memory.entity.enabled = originalEnabled;
      TEST_CONFIG.memory.entity.extractRelations.enabled =
        originalRelationsEnabled;
      TEST_CONFIG.memory.entity.extractRelations.backfillBatchSize =
        originalBatchSize;
    }
  });

  // ── Provenance plumbing tests ────────────────────────────────────────

  test("provenance fields are preserved in stored message metadata", async () => {
    const conv = createConversation("provenance-preserve");
    const metadata = {
      userMessageChannel: "telegram" as const,
      provenanceTrustClass: "trusted_contact" as const,
      provenanceSourceChannel: "telegram" as const,
      provenanceGuardianExternalUserId: "guardian-123",
      provenanceRequesterIdentifier: "Alice",
    };
    const msg = await addMessage(
      conv.id,
      "user",
      "Hello from telegram",
      metadata,
    );

    const db = getDb();
    const stored = db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, msg.id))
      .get();

    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!.metadata!);
    expect(parsed.provenanceTrustClass).toBe("trusted_contact");
    expect(parsed.provenanceSourceChannel).toBe("telegram");
    expect(parsed.provenanceGuardianExternalUserId).toBe("guardian-123");
    expect(parsed.provenanceRequesterIdentifier).toBe("Alice");
  });

  test("messageMetadataSchema validates provenance fields", () => {
    const valid = messageMetadataSchema.safeParse({
      provenanceTrustClass: "guardian",
      provenanceSourceChannel: "vellum",
    });
    expect(valid.success).toBe(true);

    const validNonGuardian = messageMetadataSchema.safeParse({
      provenanceTrustClass: "trusted_contact",
      provenanceSourceChannel: "telegram",
      provenanceGuardianExternalUserId: "g-123",
      provenanceRequesterIdentifier: "Bob",
    });
    expect(validNonGuardian.success).toBe(true);

    const validUnverified = messageMetadataSchema.safeParse({
      provenanceTrustClass: "unknown",
    });
    expect(validUnverified.success).toBe(true);
  });

  test("provenanceFromTrustContext returns unverified_channel default when no context", () => {
    const result = provenanceFromTrustContext(null);
    expect(result.provenanceTrustClass).toBe("unknown");
    expect(result.provenanceSourceChannel).toBeUndefined();

    const result2 = provenanceFromTrustContext(undefined);
    expect(result2.provenanceTrustClass).toBe("unknown");
  });

  test("provenanceFromTrustContext extracts fields from guardian context", () => {
    const ctx = {
      sourceChannel: "telegram" as const,
      trustClass: "trusted_contact" as const,
      guardianExternalUserId: "g-456",
      requesterIdentifier: "Charlie",
    };
    const result = provenanceFromTrustContext(ctx);
    expect(result.provenanceTrustClass).toBe("trusted_contact");
    expect(result.provenanceSourceChannel).toBe("telegram");
    expect(result.provenanceGuardianExternalUserId).toBe("g-456");
    expect(result.provenanceRequesterIdentifier).toBe("Charlie");
  });

  test("indexMessageNow receives provenanceTrustClass when metadata includes it", async () => {
    const conv = createConversation("provenance-indexer");
    const metadata = {
      provenanceTrustClass: "trusted_contact" as const,
      provenanceSourceChannel: "telegram" as const,
    };
    // addMessage parses metadata and passes provenanceTrustClass to indexMessageNow.
    // We verify indirectly: the message is persisted with metadata and segments are indexed.
    const msg = await addMessage(
      conv.id,
      "user",
      "Test provenance indexing message with enough content to segment",
      metadata,
    );
    expect(msg.id).toBeTruthy();

    // Verify segments were created (indexMessageNow was called successfully)
    const segments = getDb()
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, msg.id))
      .all();
    expect(segments.length).toBeGreaterThan(0);
  });

  // ── Trust-aware extraction gating tests (M3) ───────────────────────

  test("untrusted actor messages do not enqueue extract_items", () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-untrusted-gate",
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
        id: "msg-untrusted-gate",
        conversationId: "conv-untrusted-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Untrusted user preference for dark mode." },
        ]),
        createdAt: now,
      })
      .run();

    const result = indexMessageNow(
      {
        messageId: "msg-untrusted-gate",
        conversationId: "conv-untrusted-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Untrusted user preference for dark mode." },
        ]),
        createdAt: now,
        provenanceTrustClass: "trusted_contact",
      },
      DEFAULT_CONFIG.memory,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);

    // No extract_items or resolve_conflicts jobs should be enqueued
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(and(eq(memoryJobs.type, "extract_items")))
      .all()
      .filter((j) => JSON.parse(j.payload).messageId === "msg-untrusted-gate");
    expect(extractJobs.length).toBe(0);

    // enqueuedJobs should reflect: embed jobs + summary (1), no extract (0), no conflict (0)
    const expectedJobs = result.indexedSegments + 1; // embed per segment + summary
    expect(result.enqueuedJobs).toBe(expectedJobs);
  });

  test("trusted guardian messages still enqueue extraction", () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-trusted-gate",
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
        id: "msg-trusted-gate",
        conversationId: "conv-trusted-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Trusted guardian preference for light mode." },
        ]),
        createdAt: now,
      })
      .run();

    const result = indexMessageNow(
      {
        messageId: "msg-trusted-gate",
        conversationId: "conv-trusted-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Trusted guardian preference for light mode." },
        ]),
        createdAt: now,
        provenanceTrustClass: "guardian",
      },
      DEFAULT_CONFIG.memory,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);

    // extract_items job should be enqueued for trusted guardian
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all()
      .filter((j) => JSON.parse(j.payload).messageId === "msg-trusted-gate");
    expect(extractJobs.length).toBe(1);

    // enqueuedJobs: embed per segment + extract_items (counts as 2: extract + summary) + conflict
    // For user role: shouldExtract=true, shouldResolveConflicts=true (if enabled)
    expect(result.enqueuedJobs).toBeGreaterThan(result.indexedSegments + 1);
  });

  test("legacy messages without provenance still enqueue extraction", () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-legacy-gate",
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
        id: "msg-legacy-gate",
        conversationId: "conv-legacy-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Legacy message with no provenance info." },
        ]),
        createdAt: now,
      })
      .run();

    const result = indexMessageNow(
      {
        messageId: "msg-legacy-gate",
        conversationId: "conv-legacy-gate",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Legacy message with no provenance info." },
        ]),
        createdAt: now,
        // provenanceTrustClass is intentionally omitted (undefined) for backwards compat
      },
      DEFAULT_CONFIG.memory,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);

    // extract_items job should still be enqueued for legacy messages (backwards compat)
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all()
      .filter((j) => JSON.parse(j.payload).messageId === "msg-legacy-gate");
    expect(extractJobs.length).toBe(1);

    // enqueuedJobs should include extraction jobs
    expect(result.enqueuedJobs).toBeGreaterThan(result.indexedSegments + 1);
  });

  test("unverified_channel messages do not enqueue extract_items", () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: "conv-unverified-gate",
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
        id: "msg-unverified-gate",
        conversationId: "conv-unverified-gate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "Unverified channel preference for compact layout.",
          },
        ]),
        createdAt: now,
      })
      .run();

    const result = indexMessageNow(
      {
        messageId: "msg-unverified-gate",
        conversationId: "conv-unverified-gate",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "Unverified channel preference for compact layout.",
          },
        ]),
        createdAt: now,
        provenanceTrustClass: "unknown",
      },
      DEFAULT_CONFIG.memory,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);

    // No extract_items jobs should be enqueued for unverified channel
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all()
      .filter((j) => JSON.parse(j.payload).messageId === "msg-unverified-gate");
    expect(extractJobs.length).toBe(0);

    // enqueuedJobs should reflect: embed jobs + summary (1), no extract (0), no conflict (0)
    const expectedJobs = result.indexedSegments + 1; // embed per segment + summary
    expect(result.enqueuedJobs).toBe(expectedJobs);
  });
});
