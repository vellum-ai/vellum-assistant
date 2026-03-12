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

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
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
      provider: "openai" as const,
      required: false,
    },
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
    retrieval: {
      ...DEFAULT_CONFIG.memory.retrieval,
      lexicalTopK: 40,
      semanticTopK: 0,
      maxInjectTokens: 900,
      dynamicBudget: {
        ...DEFAULT_CONFIG.memory.retrieval.dynamicBudget,
        enabled: true,
        minInjectTokens: 180,
        maxInjectTokens: 360,
        targetHeadroomTokens: 700,
      },
      reranking: {
        ...DEFAULT_CONFIG.memory.retrieval.reranking,
        enabled: false,
      },
    },
    entity: {
      ...DEFAULT_CONFIG.memory.entity,
      relationRetrieval: {
        ...DEFAULT_CONFIG.memory.entity.relationRetrieval,
        enabled: true,
        maxSeedEntities: 4,
        maxNeighborEntities: 6,
        maxEdges: 8,
        neighborScoreMultiplier: 0.65,
      },
    },
    conflicts: {
      ...DEFAULT_CONFIG.memory.conflicts,
      enabled: true,
      gateMode: "soft" as const,
      relevanceThreshold: 0.2,
      resolverLlmTimeoutMs: 250,
    },
    profile: {
      ...DEFAULT_CONFIG.memory.profile,
      enabled: true,
      maxInjectTokens: 300,
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

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  resetCleanupScheduleThrottle,
  resetStaleSweepThrottle,
} from "../memory/jobs-worker.js";
import { buildMemoryRecall } from "../memory/retriever.js";
import {
  conversations,
  memoryEntities,
  memoryEntityRelations,
  memoryItemEntities,
  memoryItems,
  memoryItemSources,
  messages,
} from "../memory/schema.js";

describe("Memory lifecycle E2E regression", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
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

  test("relation expansion and profile hygiene remain consistent", async () => {
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
        {
          id: "msg-lifecycle-background",
          conversationId,
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Keep the old runtime one." },
          ]),
          createdAt: now + 500,
        },
      ])
      .run();

    db.insert(memoryItems)
      .values([
        {
          id: "item-atlas-direct",
          kind: "preference",
          subject: "atlas rollout",
          statement: "Project Atlas prefers blue-green rollouts.",
          status: "active",
          confidence: 0.95,
          importance: 0.9,
          fingerprint: "fp-item-atlas-direct",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now + 10,
          lastSeenAt: now + 10,
          validFrom: now + 10,
          invalidAt: null,
        },
        {
          id: "item-k8s-relation",
          kind: "fact",
          subject: "autoscaling",
          statement: "Scale API pods at 70% CPU with Kubernetes HPA.",
          status: "active",
          confidence: 0.82,
          importance: 0.7,
          fingerprint: "fp-item-k8s-relation",
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now + 12,
          lastSeenAt: now + 12,
          validFrom: now + 12,
          invalidAt: null,
        },
      ])
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-atlas-direct",
          messageId: "msg-lifecycle-seed",
          evidence: "Atlas rollout policy note",
          createdAt: now + 10,
        },
        {
          memoryItemId: "item-k8s-relation",
          messageId: "msg-lifecycle-seed",
          evidence: "Kubernetes autoscaling note",
          createdAt: now + 12,
        },
      ])
      .run();

    db.insert(memoryEntities)
      .values([
        {
          id: "entity-atlas-lifecycle",
          name: "Project Atlas",
          type: "project",
          aliases: JSON.stringify(["atlas"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now + 500,
          mentionCount: 4,
        },
        {
          id: "entity-kubernetes-lifecycle",
          name: "Kubernetes",
          type: "tool",
          aliases: JSON.stringify(["k8s"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now + 500,
          mentionCount: 3,
        },
      ])
      .run();

    db.insert(memoryEntityRelations)
      .values({
        id: "rel-atlas-kubernetes-lifecycle",
        sourceEntityId: "entity-atlas-lifecycle",
        targetEntityId: "entity-kubernetes-lifecycle",
        relation: "uses",
        evidence: "Project Atlas runs on Kubernetes",
        firstSeenAt: now + 20,
        lastSeenAt: now + 20,
      })
      .run();

    db.insert(memoryItemEntities)
      .values([
        {
          memoryItemId: "item-atlas-direct",
          entityId: "entity-atlas-lifecycle",
        },
        {
          memoryItemId: "item-k8s-relation",
          entityId: "entity-kubernetes-lifecycle",
        },
      ])
      .run();

    const recall = await buildMemoryRecall(
      "atlas deployment guidance",
      conversationId,
      TEST_CONFIG,
    );
    expect(recall.injectedText).toContain("blue-green rollouts");
    expect(recall.injectedText).toContain("70% CPU");
    expect(recall.relationSeedEntityCount).toBeGreaterThan(0);
    expect(recall.relationTraversedEdgeCount).toBeGreaterThan(0);
    expect(recall.relationNeighborEntityCount).toBeGreaterThan(0);
    expect(recall.relationExpandedItemCount).toBeGreaterThan(0);
  });
});
