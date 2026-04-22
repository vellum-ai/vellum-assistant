import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";

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
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
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

import { getDb, initializeDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import {
  conversations,
  cronJobs,
  cronRuns,
  memoryGraphNodes,
  memoryJobs,
  messages,
  taskRuns,
  tasks,
} from "../memory/schema.js";
import {
  invalidateAssistantInferredItemsForConversation,
  isConversationFailed,
} from "../memory/task-memory-cleanup.js";

const DEFAULT_EMOTIONAL_CHARGE =
  '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}';

describe("invalidateAssistantInferredItemsForConversation", () => {
  const now = 1_701_100_000_000;
  const convId = "conv-task-cleanup";
  const otherConvId = "conv-other";

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_graph_nodes");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM conversations");
  });

  function seedConversations() {
    const db = getDb();
    for (const id of [convId, otherConvId]) {
      db.insert(conversations)
        .values({
          id,
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
    }
  }

  function seedMessages() {
    const db = getDb();
    db.insert(messages)
      .values([
        {
          id: "msg-task-1",
          conversationId: convId,
          role: "assistant",
          content: "[]",
          createdAt: now + 10,
        },
        {
          id: "msg-task-2",
          conversationId: convId,
          role: "user",
          content: "[]",
          createdAt: now + 20,
        },
        {
          id: "msg-other",
          conversationId: otherConvId,
          role: "assistant",
          content: "[]",
          createdAt: now + 30,
        },
      ])
      .run();
  }

  function seedMemoryGraphNodes() {
    const db = getDb();
    db.insert(memoryGraphNodes)
      .values([
        {
          id: "item-assistant-inferred",
          content: "DMV appointment\nBooked a DMV appointment at 9 AM.",
          type: "semantic",
          created: now + 10,
          lastAccessed: now + 10,
          lastConsolidated: now + 10,
          emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
          fidelity: "vivid",
          confidence: 0.8,
          significance: 0.7,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now + 10,
          sourceConversations: JSON.stringify([convId]),
          sourceType: "inferred",
          narrativeRole: null,
          partOfStory: null,
          scopeId: "default",
        },
        {
          id: "item-user-reported",
          content: "notification pref\nUser prefers email notifications.",
          type: "semantic",
          created: now + 20,
          lastAccessed: now + 20,
          lastConsolidated: now + 20,
          emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
          fidelity: "vivid",
          confidence: 0.9,
          significance: 0.8,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now + 20,
          sourceConversations: JSON.stringify([convId]),
          sourceType: "direct",
          narrativeRole: null,
          partOfStory: null,
          scopeId: "default",
        },
        {
          id: "item-other-conv",
          content: "weather check\nChecked weather for tomorrow.",
          type: "semantic",
          created: now + 30,
          lastAccessed: now + 30,
          lastConsolidated: now + 30,
          emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
          fidelity: "vivid",
          confidence: 0.7,
          significance: 0.5,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now + 30,
          sourceConversations: JSON.stringify([otherConvId]),
          sourceType: "inferred",
          narrativeRole: null,
          partOfStory: null,
          scopeId: "default",
        },
        {
          id: "item-already-gone",
          content: "old claim\nOld assistant claim already gone.",
          type: "semantic",
          created: now + 5,
          lastAccessed: now + 5,
          lastConsolidated: now + 5,
          emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
          fidelity: "gone",
          confidence: 0.6,
          significance: 0.4,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now + 5,
          sourceConversations: JSON.stringify([convId]),
          sourceType: "inferred",
          narrativeRole: null,
          partOfStory: null,
          scopeId: "default",
        },
      ])
      .run();
  }

  test("only invalidates inferred items, not direct (user-reported)", () => {
    seedConversations();
    seedMessages();
    seedMemoryGraphNodes();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    expect(affected).toBe(1);

    const db = getDb();
    const inferredItem = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-assistant-inferred"))
      .get();
    expect(inferredItem?.fidelity).toBe("gone");

    const directItem = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-user-reported"))
      .get();
    expect(directItem?.fidelity).toBe("vivid");
  });

  test("does not affect items from other conversations", () => {
    seedConversations();
    seedMessages();
    seedMemoryGraphNodes();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const otherItem = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-other-conv"))
      .get();
    expect(otherItem?.fidelity).toBe("vivid");
  });

  test("does not invalidate items also sourced from another conversation", () => {
    seedConversations();
    seedMessages();

    // Insert a node sourced from both conversations (corroboration).
    const db = getDb();
    db.insert(memoryGraphNodes)
      .values({
        id: "item-corroborated",
        content: "DMV appointment\nBooked a DMV appointment at 9 AM.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 10,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convId, otherConvId]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId: "default",
      })
      .run();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    // The item has sources from both conversations, so it should NOT be invalidated.
    expect(affected).toBe(0);

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-corroborated"))
      .get();
    expect(item?.fidelity).toBe("vivid");
  });

  test("does not affect already-gone items", () => {
    seedConversations();
    seedMessages();
    seedMemoryGraphNodes();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const goneItem = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-already-gone"))
      .get();
    expect(goneItem?.fidelity).toBe("gone");
  });

  test("returns 0 when no matching items exist", () => {
    seedConversations();
    seedMessages();
    // No memory graph nodes seeded

    const affected = invalidateAssistantInferredItemsForConversation(convId);
    expect(affected).toBe(0);
  });

  test("returns 0 for unknown conversation", () => {
    seedConversations();
    seedMessages();
    seedMemoryGraphNodes();

    const affected =
      invalidateAssistantInferredItemsForConversation("conv-nonexistent");
    expect(affected).toBe(0);
  });

  test("invalidates items when corroborating conversation is also from a failed task run", () => {
    const db = getDb();
    const convA = "conv-failed-task-a";
    const convB = "conv-failed-task-b";

    // Create two conversations, each from a failed task run
    for (const id of [convA, convB]) {
      db.insert(conversations)
        .values({
          id,
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
    }

    db.insert(messages)
      .values([
        {
          id: "msg-a",
          conversationId: convA,
          role: "assistant",
          content: "[]",
          createdAt: now + 10,
        },
        {
          id: "msg-b",
          conversationId: convB,
          role: "assistant",
          content: "[]",
          createdAt: now + 20,
        },
      ])
      .run();

    // Both conversations are from failed task runs
    db.insert(tasks)
      .values({
        id: "task-1",
        title: "Test task",
        template: "template",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(taskRuns)
      .values([
        {
          id: "run-a",
          taskId: "task-1",
          conversationId: convA,
          status: "failed",
          createdAt: now + 10,
        },
        {
          id: "run-b",
          taskId: "task-1",
          conversationId: convB,
          status: "failed",
          createdAt: now + 20,
        },
      ])
      .run();

    // A memory node sourced from both failed conversations
    db.insert(memoryGraphNodes)
      .values({
        id: "item-cross-sourced",
        content: "cross-sourced claim\nClaim from two failed tasks.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 20,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convA, convB]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId: "default",
      })
      .run();

    // Invalidating for convA should succeed because convB is also from a failed task
    const affected = invalidateAssistantInferredItemsForConversation(convA);
    expect(affected).toBe(1);

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-cross-sourced"))
      .get();
    expect(item?.fidelity).toBe("gone");
  });

  test("invalidates items when corroborating conversation is from a failed schedule run", () => {
    const db = getDb();
    const convA = "conv-failed-sched-a";
    const convB = "conv-failed-sched-b";

    for (const id of [convA, convB]) {
      db.insert(conversations)
        .values({
          id,
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
    }

    db.insert(messages)
      .values([
        {
          id: "msg-sched-a",
          conversationId: convA,
          role: "assistant",
          content: "[]",
          createdAt: now + 10,
        },
        {
          id: "msg-sched-b",
          conversationId: convB,
          role: "assistant",
          content: "[]",
          createdAt: now + 20,
        },
      ])
      .run();

    // Both conversations are from failed schedule runs
    db.insert(cronJobs)
      .values({
        id: "cron-1",
        name: "Test schedule",
        cronExpression: "0 9 * * *",
        message: "test",
        nextRunAt: now + 100_000,
        createdBy: "agent",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(cronRuns)
      .values([
        {
          id: "cron-run-a",
          jobId: "cron-1",
          status: "error",
          conversationId: convA,
          startedAt: now + 10,
          createdAt: now + 10,
        },
        {
          id: "cron-run-b",
          jobId: "cron-1",
          status: "error",
          conversationId: convB,
          startedAt: now + 20,
          createdAt: now + 20,
        },
      ])
      .run();

    db.insert(memoryGraphNodes)
      .values({
        id: "item-cross-sched",
        content:
          "cross-sourced schedule claim\nClaim from two failed schedules.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 20,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convA, convB]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId: "default",
      })
      .run();

    const affected = invalidateAssistantInferredItemsForConversation(convA);
    expect(affected).toBe(1);

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-cross-sched"))
      .get();
    expect(item?.fidelity).toBe("gone");
  });

  test("preserves items when corroborating conversation is from a successful task run", () => {
    const db = getDb();
    const convFailed = "conv-failed-task";
    const convSuccess = "conv-success-task";

    for (const id of [convFailed, convSuccess]) {
      db.insert(conversations)
        .values({
          id,
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
    }

    db.insert(messages)
      .values([
        {
          id: "msg-failed",
          conversationId: convFailed,
          role: "assistant",
          content: "[]",
          createdAt: now + 10,
        },
        {
          id: "msg-success",
          conversationId: convSuccess,
          role: "assistant",
          content: "[]",
          createdAt: now + 20,
        },
      ])
      .run();

    db.insert(tasks)
      .values({
        id: "task-2",
        title: "Test task 2",
        template: "template",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(taskRuns)
      .values([
        {
          id: "run-failed",
          taskId: "task-2",
          conversationId: convFailed,
          status: "failed",
          createdAt: now + 10,
        },
        {
          id: "run-success",
          taskId: "task-2",
          conversationId: convSuccess,
          status: "completed",
          createdAt: now + 20,
        },
      ])
      .run();

    db.insert(memoryGraphNodes)
      .values({
        id: "item-with-good-corroboration",
        content: "corroborated claim\nClaim corroborated by successful task.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 20,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convFailed, convSuccess]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId: "default",
      })
      .run();

    // The successful task run corroborates the claim, so it should NOT be invalidated
    const affected =
      invalidateAssistantInferredItemsForConversation(convFailed);
    expect(affected).toBe(0);

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.id, "item-with-good-corroboration"))
      .get();
    expect(item?.fidelity).toBe("vivid");
  });

  test("isConversationFailed derives state from durable task_runs/cron_runs", () => {
    seedConversations();
    seedMessages();

    const db = getDb();

    // No failure records yet — should be false
    expect(isConversationFailed(convId)).toBe(false);
    expect(isConversationFailed(otherConvId)).toBe(false);

    // Insert a failed task run for convId
    db.insert(tasks)
      .values({
        id: "task-durable",
        title: "Durable test",
        template: "template",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(taskRuns)
      .values({
        id: "run-durable",
        taskId: "task-durable",
        conversationId: convId,
        status: "failed",
        createdAt: now + 50,
      })
      .run();

    // Now convId should be detected as failed via the DB
    expect(isConversationFailed(convId)).toBe(true);
    // Other conversations remain unaffected
    expect(isConversationFailed(otherConvId)).toBe(false);
  });

  test("isConversationFailed detects failed schedule runs", () => {
    seedConversations();
    seedMessages();

    const db = getDb();

    expect(isConversationFailed(convId)).toBe(false);

    // Insert a failed schedule run for convId
    db.insert(cronJobs)
      .values({
        id: "cron-durable",
        name: "Durable schedule test",
        cronExpression: "0 9 * * *",
        message: "test",
        nextRunAt: now + 100_000,
        createdBy: "agent",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(cronRuns)
      .values({
        id: "cron-run-durable",
        jobId: "cron-durable",
        status: "error",
        conversationId: convId,
        startedAt: now + 50,
        createdAt: now + 50,
      })
      .run();

    expect(isConversationFailed(convId)).toBe(true);
    expect(isConversationFailed(otherConvId)).toBe(false);
  });

  test("cancels pending graph_extract jobs for the failed conversation", () => {
    seedConversations();
    seedMessages();

    const db = getDb();

    // Enqueue graph_extract jobs for the target conversation
    enqueueMemoryJob("graph_extract", {
      conversationId: convId,
      scopeId: "default",
    });
    enqueueMemoryJob("graph_extract", {
      conversationId: convId,
      scopeId: "default",
    });
    // Enqueue a graph_extract job for a different conversation
    enqueueMemoryJob("graph_extract", {
      conversationId: otherConvId,
      scopeId: "default",
    });

    // Verify all jobs are pending
    const pendingBefore = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();
    expect(pendingBefore.filter((j) => j.status === "pending")).toHaveLength(3);

    invalidateAssistantInferredItemsForConversation(convId);

    // Jobs for the failed conversation should be cancelled (failed)
    const allJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();
    const failedJobs = allJobs.filter((j) => j.status === "failed");
    const pendingJobs = allJobs.filter((j) => j.status === "pending");

    // Two jobs for the failed conversation should be cancelled
    expect(failedJobs).toHaveLength(2);
    for (const j of failedJobs) {
      expect(j.lastError).toBe("conversation_failed");
    }

    // The job for the other conversation should remain pending
    expect(pendingJobs).toHaveLength(1);
    const payload = JSON.parse(pendingJobs[0].payload);
    expect(payload.conversationId).toBe(otherConvId);
  });
});
