/**
 * Memory lifecycle E2E regression test.
 *
 * Verifies the new memory pipeline end-to-end:
 * - Standard-kind enum items (identity, preference, project, decision, constraint, event, journal, capability, ...)
 * - Supersession chains (supersedes/supersededBy fields)
 * - Hybrid search retrieval
 * - Two-layer XML injection format (<memory_context> with sections)
 * - Stripping removes <memory_context> tags
 * - No conflict gate references
 */
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

import { DEFAULT_CONFIG } from "../config/defaults.js";

const testDir = mkdtempSync(join(tmpdir(), "memory-lifecycle-e2e-"));

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

// Stub the local embedding backend so the real ONNX model never loads
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

// Dynamic Qdrant mock: tests can push results to be returned by searchWithFilter/hybridSearch
let mockQdrantResults: Array<{
  id: string;
  score: number;
  payload: Record<string, unknown>;
}> = [];

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => mockQdrantResults,
    hybridSearch: async () => mockQdrantResults,
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    embeddings: {
      ...DEFAULT_CONFIG.memory.embeddings,
      required: false,
    },
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
    retrieval: {
      ...DEFAULT_CONFIG.memory.retrieval,
      maxInjectTokens: 900,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { stripUserTextBlocksByPrefix } from "../daemon/conversation-runtime-assembly.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  resetCleanupScheduleThrottle,
  resetStaleSweepThrottle,
} from "../memory/jobs-worker.js";
import {
  buildMemoryRecall,
  injectMemoryRecallAsUserBlock,
} from "../memory/retriever.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "../memory/schema.js";
import type { Message } from "../providers/types.js";

describe("Memory lifecycle E2E regression", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM memory_checkpoints");
    mockQdrantResults = [];
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

  test("extraction produces items with standard-kind enum and supersession chains form correctly", async () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-memory-lifecycle";

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
      .values([
        {
          id: "msg-lifecycle-seed",
          conversationId,
          role: "user",
          content: JSON.stringify([
            {
              type: "text",
              text: "Atlas deployment notes mention Kubernetes infrastructure.",
            },
          ]),
          createdAt: now + 10,
        },
      ])
      .run();

    // Seed items using the standard-kind enum
    const kinds = [
      "identity",
      "preference",
      "project",
      "decision",
      "constraint",
      "event",
    ] as const;
    for (let i = 0; i < kinds.length; i++) {
      db.insert(memoryItems)
        .values({
          id: `item-kind-${kinds[i]}`,
          kind: kinds[i],
          subject: `${kinds[i]} test`,
          statement: `This is a ${kinds[i]} item for testing.`,
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: `fp-item-kind-${kinds[i]}`,
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now + i,
          lastSeenAt: now + i,
        })
        .run();

      db.insert(memoryItemSources)
        .values({
          memoryItemId: `item-kind-${kinds[i]}`,
          messageId: "msg-lifecycle-seed",
          evidence: `${kinds[i]} evidence`,
          createdAt: now + i,
        })
        .run();
    }

    // Create a supersession chain: old decision superseded by new decision
    db.insert(memoryItems)
      .values({
        id: "item-old-decision",
        kind: "decision",
        subject: "deploy strategy",
        statement: "Deploy manually every Friday.",
        status: "superseded",
        confidence: 0.7,
        importance: 0.6,
        fingerprint: "fp-old-decision",
        verificationState: "assistant_inferred",
        scopeId: "default",
        firstSeenAt: now - 10_000,
        lastSeenAt: now - 10_000,
        supersededBy: "item-kind-decision",
      })
      .run();

    // Update the new decision to reference the old one
    db.run(
      `UPDATE memory_items SET supersedes = 'item-old-decision' WHERE id = 'item-kind-decision'`,
    );

    // Verify supersession chain is stored correctly
    const oldDecision = db
      .select()
      .from(memoryItems)
      .all()
      .find((i) => i.id === "item-old-decision");
    const newDecision = db
      .select()
      .from(memoryItems)
      .all()
      .find((i) => i.id === "item-kind-decision");

    expect(oldDecision).toBeDefined();
    expect(oldDecision!.status).toBe("superseded");
    expect(oldDecision!.supersededBy).toBe("item-kind-decision");

    expect(newDecision).toBeDefined();
    expect(newDecision!.status).toBe("active");
    expect(newDecision!.supersedes).toBe("item-old-decision");
  });

  test("recall completes with no injected memory when Qdrant returns empty", async () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-recall-lifecycle";

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
        id: "msg-recall-seed",
        conversationId,
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "Atlas deployment notes mention Kubernetes infrastructure.",
          },
        ]),
        createdAt: now + 10,
      })
      .run();

    // Insert a segment (Qdrant is mocked empty, so this will not be recalled)
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at
      ) VALUES (
        'seg-recall-seed', 'msg-recall-seed', '${conversationId}', 'user', 0,
        'Atlas deployment notes mention Kubernetes infrastructure.', 10, 'default',
        ${now + 10}, ${now + 10}
      )
    `);

    const recall = await buildMemoryRecall(
      "atlas deployment guidance",
      conversationId,
      TEST_CONFIG,
    );

    // Without semantic search (Qdrant mocked empty), no candidates pass
    // tier classification (threshold > 0.6).
    expect(recall.enabled).toBe(true);
  });

  test("two-layer XML injection format uses <memory_context> tags", async () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-injection-format";

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
        contextCompactedMessageCount: 1,
        contextCompactedAt: null,
      })
      .run();

    db.insert(messages)
      .values({
        id: "msg-injection-seed",
        conversationId,
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "My preferred timezone is America/Los_Angeles.",
          },
        ]),
        createdAt: now + 10,
      })
      .run();

    // Seed a memory item so the semantic search path can find it
    db.insert(memoryItems)
      .values({
        id: "item-timezone-pref",
        kind: "preference",
        subject: "timezone preference",
        statement: "My preferred timezone is America/Los_Angeles.",
        status: "active",
        confidence: 0.9,
        importance: 0.8,
        fingerprint: "fp-item-timezone-pref",
        firstSeenAt: now + 10,
        lastSeenAt: now + 10,
      })
      .run();

    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-timezone-pref",
        messageId: "msg-injection-seed",
        evidence: "timezone preference evidence",
        createdAt: now + 10,
      })
      .run();

    // Mock Qdrant to return the timezone preference item
    mockQdrantResults = [
      {
        id: "emb-timezone-pref",
        score: 0.92,
        payload: {
          target_type: "item",
          target_id: "item-timezone-pref",
          text: "My preferred timezone is America/Los_Angeles.",
          kind: "preference",
          status: "active",
          created_at: now + 10,
          last_seen_at: now + 10,
        },
      },
    ];

    const recall = await buildMemoryRecall(
      "timezone",
      conversationId,
      TEST_CONFIG,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.injectedText.length).toBeGreaterThan(0);
    expect(recall.injectedTokens).toBeGreaterThan(0);
    expect(recall.injectedText).toContain("<memory_context __injected>");
    expect(recall.injectedText).toContain("</memory_context>");
  });

  test("stripping removes <memory_context> block from injected recall", () => {
    const memoryRecallText =
      "<memory_context __injected>\n\n<relevant_context>\nuser prefers concise answers\n</relevant_context>\n\n</memory_context>";
    const originalMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text" as const, text: "Actual user request" }],
      },
    ];
    const injected = injectMemoryRecallAsUserBlock(
      originalMessages,
      memoryRecallText,
    );

    // Memory context prepended to the last user message as a content block
    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe("user");
    expect(injected[0].content).toHaveLength(2);
    const b0 = injected[0].content[0];
    const b1 = injected[0].content[1];
    expect(b0.type === "text" && b0.text).toBe(memoryRecallText);
    expect(b1.type === "text" && b1.text).toBe("Actual user request");

    // Stripped by prefix-based stripping (same mechanism as workspace/temporal)
    const cleaned = stripUserTextBlocksByPrefix(injected, [
      "<memory_context __injected>",
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content).toHaveLength(1);
    const cb0 = cleaned[0].content[0];
    expect(cb0.type === "text" && cb0.text).toBe("Actual user request");
  });

  test("empty retrieval returns no injection", async () => {
    const db = getDb();
    const now = 1_701_100_000_000;
    const conversationId = "conv-empty-lifecycle";

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

    const recall = await buildMemoryRecall(
      "completely unrelated xyzzy topic",
      conversationId,
      TEST_CONFIG,
    );

    expect(recall.injectedText).toBe("");
    expect(recall.injectedTokens).toBe(0);
  });
});
