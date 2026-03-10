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
import { estimatePromptTokens } from "../context/token-estimator.js";
import { ContextWindowManager } from "../context/window-manager.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { buildMemoryQuery } from "../memory/query-builder.js";
import { computeRecallBudget } from "../memory/retrieval-budget.js";
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
import type { Message, Provider } from "../providers/types.js";

const testDir = mkdtempSync(join(tmpdir(), "context-memory-e2e-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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

function makeSummaryProvider(counter: { calls: number }): Provider {
  return {
    name: "mock",
    async sendMessage() {
      counter.calls += 1;
      return {
        content: [
          {
            type: "text",
            text: "## Goals\n- Keep memory stable\n## Decisions\n- Use progressive rollouts",
          },
        ],
        model: "mock-context-model",
        usage: { inputTokens: 300, outputTokens: 60 },
        stopReason: "end_turn",
      };
    },
  };
}

function makeLongHistory(turns: number, finalUserText: string): Message[] {
  const rows: Message[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `[U${i}] Apollo planning thread ${i}: discuss rollout safeguards and runbooks.`,
        },
      ],
    });
    rows.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[A${i}] Captured safeguards ${i}: staged rollout, monitoring, and rollback readiness.`,
        },
      ],
    });
  }
  rows.push({
    role: "user",
    content: [{ type: "text", text: finalUserText }],
  });
  return rows;
}

function insertSegment(
  id: string,
  messageId: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
): void {
  const db = getDb();
  db.run(`
    INSERT INTO memory_segments (
      id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at
    ) VALUES (
      '${id}', '${messageId}', '${conversationId}', '${role}', 0, '${text.replace(
        /'/g,
        "''",
      )}', ${Math.max(
        6,
        Math.ceil(text.split(/\s+/).length * 1.3),
      )}, 'default', ${createdAt}, ${createdAt}
    )
  `);
}

function insertMemoryItem(opts: {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  firstSeenAt: number;
  lastSeenAt: number;
}): void {
  const db = getDb();
  db.insert(memoryItems)
    .values({
      id: opts.id,
      kind: opts.kind,
      subject: opts.subject,
      statement: opts.statement,
      status: "active",
      confidence: opts.confidence,
      importance: opts.importance,
      fingerprint: `fp-${opts.id}`,
      firstSeenAt: opts.firstSeenAt,
      lastSeenAt: opts.lastSeenAt,
      lastUsedAt: null,
      scopeId: "default",
    })
    .run();
}

describe("Context + Memory E2E regression", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_item_entities");
    db.run("DELETE FROM memory_entity_relations");
    db.run("DELETE FROM memory_entities");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_summaries");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_segment_fts");
    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM memory_checkpoints");
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test("one-turn flow compacts context, enforces dynamic budget, and recalls relation-linked memory", async () => {
    const db = getDb();
    const conversationId = "conv-context-memory-e2e";
    const now = 1_700_900_000_000;
    const currentMessageId = "msg-e2e-current";
    const currentUserText =
      "For Apollo, what rollout should we use this week? Also tracking note: Apollo secret code 123XYZ.";

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

    const seededMessages = [
      {
        id: "msg-e2e-user-2",
        role: "user",
        text: "Historical deployment note kept for audit context.",
        createdAt: now + 2_000,
      },
      {
        id: "msg-e2e-user-10",
        role: "user",
        text: "Sprint review confirmed Apollo rollout policy and guardrails.",
        createdAt: now + 10_000,
      },
      {
        id: "msg-e2e-user-12",
        role: "user",
        text: "Playbook update captured HermesGate ramp guidance.",
        createdAt: now + 12_000,
      },
      {
        id: "msg-e2e-assistant-12",
        role: "assistant",
        text: "Acknowledged rollout notes and linked them to operations memory.",
        createdAt: now + 12_001,
      },
    ] as const;

    for (const row of seededMessages) {
      db.insert(messages)
        .values({
          id: row.id,
          conversationId,
          role: row.role,
          content: JSON.stringify([{ type: "text", text: row.text }]),
          createdAt: row.createdAt,
        })
        .run();
      insertSegment(
        `seg-${row.id}`,
        row.id,
        conversationId,
        row.role,
        row.text,
        row.createdAt,
      );
    }

    db.insert(messages)
      .values({
        id: currentMessageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: currentUserText }]),
        createdAt: now + 100_000,
      })
      .run();
    insertSegment(
      "seg-e2e-current",
      currentMessageId,
      conversationId,
      "user",
      currentUserText,
      now + 100_000,
    );

    db.insert(memoryEntities)
      .values([
        {
          id: "entity-apollo",
          name: "Apollo",
          type: "project",
          aliases: JSON.stringify(["project-apollo"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now + 100_000,
          mentionCount: 6,
        },
        {
          id: "entity-hermes",
          name: "HermesGate",
          type: "strategy",
          aliases: JSON.stringify(["hermes-gate"]),
          description: null,
          firstSeenAt: now,
          lastSeenAt: now + 100_000,
          mentionCount: 4,
        },
      ])
      .run();

    db.insert(memoryEntityRelations)
      .values({
        id: "rel-apollo-hermes",
        sourceEntityId: "entity-apollo",
        targetEntityId: "entity-hermes",
        relation: "uses",
        evidence: "Apollo uses HermesGate for risky changes",
        firstSeenAt: now,
        lastSeenAt: now + 50_000,
      })
      .run();

    insertMemoryItem({
      id: "item-apollo-direct",
      kind: "preference",
      subject: "apollo rollout policy",
      statement:
        "Apollo rollout policy favors staged canary releases with guarded traffic ramps.",
      confidence: 0.95,
      importance: 0.95,
      firstSeenAt: now + 10_000,
      lastSeenAt: now + 50_000,
    });
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-apollo-direct",
        messageId: "msg-e2e-user-10",
        evidence: "User confirmed policy in sprint review",
        createdAt: now + 10_000,
      })
      .run();
    db.insert(memoryItemEntities)
      .values({
        memoryItemId: "item-apollo-direct",
        entityId: "entity-apollo",
      })
      .run();

    insertMemoryItem({
      id: "item-hermes-relation",
      kind: "fact",
      subject: "hermes rollout execution",
      statement:
        "HermesGate rollout guidance: start at 5% traffic and promote only after error budget checks pass.",
      confidence: 0.8,
      importance: 0.6,
      firstSeenAt: now + 12_000,
      lastSeenAt: now + 52_000,
    });
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-hermes-relation",
        messageId: "msg-e2e-user-12",
        evidence: "Rollout playbook notes",
        createdAt: now + 12_000,
      })
      .run();
    db.insert(memoryItemEntities)
      .values({
        memoryItemId: "item-hermes-relation",
        entityId: "entity-hermes",
      })
      .run();

    insertMemoryItem({
      id: "item-apollo-stale",
      kind: "event",
      subject: "legacy deploy process",
      statement:
        "Legacy note from years ago: Apollo deployments were manual and unmonitored.",
      confidence: 0.6,
      importance: 0.3,
      firstSeenAt: now - 400 * 24 * 60 * 60 * 1000,
      lastSeenAt: now - 390 * 24 * 60 * 60 * 1000,
    });
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-apollo-stale",
        messageId: "msg-e2e-user-2",
        evidence: "Historical note",
        createdAt: now - 390 * 24 * 60 * 60 * 1000,
      })
      .run();
    db.insert(memoryItemEntities)
      .values({
        memoryItemId: "item-apollo-stale",
        entityId: "entity-apollo",
      })
      .run();

    insertMemoryItem({
      id: "item-apollo-secret",
      kind: "fact",
      subject: "apollo secret",
      statement: "Current-turn secret: Apollo code is 123XYZ.",
      confidence: 0.99,
      importance: 0.99,
      firstSeenAt: now + 100_000,
      lastSeenAt: now + 100_000,
    });
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-apollo-secret",
        messageId: currentMessageId,
        evidence: "Current turn only",
        createdAt: now + 100_000,
      })
      .run();
    db.insert(memoryItemEntities)
      .values({
        memoryItemId: "item-apollo-secret",
        entityId: "entity-apollo",
      })
      .run();

    const summaryCounter = { calls: 0 };
    const provider = makeSummaryProvider(summaryCounter);
    const systemPrompt = "System prompt for context + memory e2e";
    const history = makeLongHistory(60, currentUserText);
    const manager = new ContextWindowManager({
      provider,
      systemPrompt,
      config: {
        ...DEFAULT_CONFIG.contextWindow,
        maxInputTokens: 5200,
        targetInputTokens: 2600,
        compactThreshold: 0.55,
        preserveRecentUserTurns: 6,
        summaryBudgetRatio: 0.05,
      },
    });

    const compacted = await manager.maybeCompact(history);
    expect(compacted.compacted).toBe(true);
    expect(compacted.summaryCalls).toBe(summaryCounter.calls);
    expect(compacted.estimatedInputTokens).toBeLessThan(
      compacted.previousEstimatedInputTokens,
    );

    const recallConfig = {
      ...DEFAULT_CONFIG,
      contextWindow: { ...DEFAULT_CONFIG.contextWindow, maxInputTokens: 5200 },
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "openai" as const,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          lexicalTopK: 50,
          semanticTopK: 16,
          maxInjectTokens: 900,
          reranking: {
            ...DEFAULT_CONFIG.memory.retrieval.reranking,
            enabled: false,
          },
          dynamicBudget: {
            enabled: true,
            minInjectTokens: 180,
            maxInjectTokens: 320,
            targetHeadroomTokens: 700,
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
      },
    };

    const estimatedPromptTokens = estimatePromptTokens(
      compacted.messages,
      systemPrompt,
      { providerName: provider.name },
    );

    const recallBudget = computeRecallBudget({
      estimatedPromptTokens,
      maxInputTokens: recallConfig.contextWindow.maxInputTokens,
      targetHeadroomTokens:
        recallConfig.memory.retrieval.dynamicBudget.targetHeadroomTokens,
      minInjectTokens:
        recallConfig.memory.retrieval.dynamicBudget.minInjectTokens,
      maxInjectTokens:
        recallConfig.memory.retrieval.dynamicBudget.maxInjectTokens,
    });

    const recallQuery = buildMemoryQuery(currentUserText, compacted.messages);
    const recall = await buildMemoryRecall(
      recallQuery,
      conversationId,
      recallConfig,
      {
        excludeMessageIds: [currentMessageId],
        maxInjectTokensOverride: recallBudget,
      },
    );

    expect(recall.injectedTokens).toBeLessThanOrEqual(recallBudget);
    expect(recall.relationSeedEntityCount).toBeGreaterThan(0);
    expect(recall.relationTraversedEdgeCount).toBeGreaterThan(0);
    expect(recall.relationNeighborEntityCount).toBeGreaterThan(0);
    expect(recall.relationExpandedItemCount).toBeGreaterThan(0);

    expect(recall.injectedText).toContain("staged canary releases");
    expect(recall.injectedText).toContain("start at 5% traffic");
    expect(recall.injectedText).not.toContain("123XYZ");

    const directIndex = recall.injectedText.indexOf("staged canary releases");
    const relationIndex = recall.injectedText.indexOf("start at 5% traffic");
    expect(directIndex).toBeGreaterThanOrEqual(0);
    expect(relationIndex).toBeGreaterThanOrEqual(0);
    expect(directIndex).toBeLessThan(relationIndex);
  });
});
