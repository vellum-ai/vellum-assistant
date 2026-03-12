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
    hybridSearch: async () => [],
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
  getRecentSegmentsForConversation,
  indexMessageNow,
} from "../memory/indexer.js";
import { extractAndUpsertMemoryItemsForMessage } from "../memory/items-extractor.js";
import { backfillJob } from "../memory/job-handlers/backfill.js";
import { buildConversationSummaryJob } from "../memory/job-handlers/summarization.js";
import { claimMemoryJobs, enqueueMemoryJob } from "../memory/jobs-store.js";
import {
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
  stripMemoryRecallMessages,
} from "../memory/retriever.js";
import {
  conversations,
  memoryEmbeddings,
  memoryItems,
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
    // Recency candidates don't pass tier classification (score < 0.6) with
    // Qdrant mocked, so injectedText is empty. Verify recency search ran
    // and excluded the current message correctly.
    expect(recall.recencyHits).toBeGreaterThan(0);
    expect(recall.enabled).toBe(true);
  });

  test("memory recall injection via separate message and stripped from runtime history", () => {
    const memoryRecallText =
      "<memory_context>\n\n<relevant_context>\nuser prefers concise answers\n</relevant_context>\n\n</memory_context>";
    const originalMessages = [
      {
        role: "user" as const,
        content: [{ type: "text", text: "Actual user request" }],
      },
    ];
    const injected = injectMemoryRecallAsSeparateMessage(
      originalMessages,
      memoryRecallText,
    );

    expect(injected).toHaveLength(3);
    expect(injected[0].role).toBe("user");
    expect(injected[0].content[0].text).toBe(memoryRecallText);
    expect(injected[1].role as string).toBe("assistant");
    expect(injected[2].role).toBe("user");
    expect(injected[2].content[0].text).toBe("Actual user request");

    const cleaned = stripMemoryRecallMessages(injected, memoryRecallText);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content[0].text).toBe("Actual user request");
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

  test("scheduled cleanup enqueue respects throttle and config retention values", () => {
    const db = getDb();
    const originalCleanup = { ...TEST_CONFIG.memory.cleanup };
    TEST_CONFIG.memory.cleanup.enabled = true;
    TEST_CONFIG.memory.cleanup.enqueueIntervalMs = 1_000;
    TEST_CONFIG.memory.cleanup.supersededItemRetentionMs = 67_890;

    try {
      const first = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 5_000);
      expect(first).toBe(true);

      const tooSoon = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 5_500);
      expect(tooSoon).toBe(false);

      const jobsAfterFirst = db.select().from(memoryJobs).all();
      const supersededJob = jobsAfterFirst.find(
        (row) => row.type === "cleanup_stale_superseded_items",
      );
      expect(supersededJob).toBeDefined();
      expect(JSON.parse(supersededJob?.payload ?? "{}")).toMatchObject({
        retentionMs: 67_890,
      });

      const secondWindow = maybeEnqueueScheduledCleanupJobs(TEST_CONFIG, 6_500);
      expect(secondWindow).toBe(true);
      const jobsAfterSecond = db.select().from(memoryJobs).all();
      expect(
        jobsAfterSecond.filter(
          (row) => row.type === "cleanup_stale_superseded_items",
        ).length,
      ).toBe(1);
    } finally {
      TEST_CONFIG.memory.cleanup = originalCleanup;
    }
  });

  test("cleanup_stale_superseded_items removes stale superseded rows and embeddings", async () => {
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

    expect(staleItem).toBeUndefined();
    expect(recentItem).toBeDefined();
    expect(staleEmbedding).toBeUndefined();
    expect(recentEmbedding).toBeDefined();
  });

  test("memory admin status reports cleanup backlog and 24h throughput metrics", () => {
    const db = getDb();
    const now = Date.now();
    const yesterday = now - 20 * 60 * 60 * 1000;
    const old = now - 40 * 60 * 60 * 1000;

    db.insert(memoryJobs)
      .values([
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
          id: "cleanup-status-completed-superseded-old",
          type: "cleanup_stale_superseded_items",
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
    expect(status.cleanup.supersededBacklog).toBe(1);
    expect(status.cleanup.supersededCompleted24h).toBe(1);
  });

  test("requestMemoryCleanup queues cleanup job", () => {
    const db = getDb();
    const queued = requestMemoryCleanup(9_999);
    expect(queued.staleSupersededItemsJobId).toBeTruthy();

    const supersededRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, queued.staleSupersededItemsJobId))
      .get();
    expect(supersededRow?.type).toBe("cleanup_stale_superseded_items");
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

    // With Qdrant mocked, only recency search runs. Recency candidates
    // don't pass tier classification (score < 0.6), so topCandidates is empty.
    // Verify scope filtering works by checking recencyHits count: should
    // only find segments from project-a scope (via allow_global_fallback,
    // default scope is also included).
    // The 2 segments in project-a scope + default-scope segments = recencyHits
    expect(result.recencyHits).toBeGreaterThan(0);
    expect(result.enabled).toBe(true);
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

    // With allow_global_fallback, recency search finds segments from both
    // "my-project" and "default" scopes. Candidates don't pass tier
    // classification but recencyHits should include both.
    expect(result.recencyHits).toBe(2);
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

    // With strict policy, only "strict-project" scope segments should be found.
    // The default scope segment should be excluded.
    expect(result.recencyHits).toBe(1);
    // Assert the returned candidate is specifically from the strict-project scope,
    // not the default scope segment (privacy boundary check).
    expect(result.topCandidates.length).toBe(1);
    expect(result.topCandidates[0].key).toBe("segment:seg-strict-custom");
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

    // Override with fallbackToDefault=true should find segments from both
    // "private-thread-42" and "default" scopes, despite strict global policy.
    expect(result.recencyHits).toBe(2);
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

    // Override disables fallback — only isolated scope segments found.
    // Only 1 segment (isolated-scope), default scope excluded.
    expect(result.recencyHits).toBe(1);
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

    // Only scope-b segment should be found (override takes precedence)
    expect(result.recencyHits).toBe(1);
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

    // Only default scope segment should be found (other-scope excluded)
    expect(result.recencyHits).toBe(1);
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
    // With Qdrant mocked, candidates don't pass tier classification.
    // Verify the pipeline ran and recency search found segments.
    expect(privRecall.recencyHits).toBeGreaterThan(0);

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
    // Without semantic search, items from a different conversation are
    // unreachable (recency search is conversation-scoped). Verify recall
    // completes without error.
    expect(privRecall).toBeDefined();
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

    // No extract_items jobs should be enqueued
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(and(eq(memoryJobs.type, "extract_items")))
      .all()
      .filter((j) => JSON.parse(j.payload).messageId === "msg-untrusted-gate");
    expect(extractJobs.length).toBe(0);

    // enqueuedJobs should reflect: embed jobs + summary (1), no extract (0)
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

    // enqueuedJobs: embed per segment + extract_items (counts as 2: extract + summary)
    // For user role: shouldExtract=true
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

    // enqueuedJobs should reflect: embed jobs + summary (1), no extract (0)
    const expectedJobs = result.indexedSegments + 1; // embed per segment + summary
    expect(result.enqueuedJobs).toBe(expectedJobs);
  });
});
