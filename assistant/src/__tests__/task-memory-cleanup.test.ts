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

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";

const testDir = mkdtempSync(join(tmpdir(), "task-memory-cleanup-"));

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

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import {
  conversations,
  cronJobs,
  cronRuns,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  messages,
  taskRuns,
  tasks,
} from "../memory/schema.js";
import {
  invalidateAssistantInferredItemsForConversation,
  isConversationFailed,
} from "../memory/task-memory-cleanup.js";

describe("invalidateAssistantInferredItemsForConversation", () => {
  const now = 1_701_100_000_000;
  const convId = "conv-task-cleanup";
  const otherConvId = "conv-other";

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM conversations");
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort
    }
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

  function seedMemoryItems() {
    const db = getDb();
    db.insert(memoryItems)
      .values([
        {
          id: "item-assistant-inferred",
          kind: "fact",
          subject: "DMV appointment",
          statement: "Booked a DMV appointment at 9 AM.",
          status: "active",
          confidence: 0.8,
          importance: 0.7,
          fingerprint: "fp-assistant-inferred",
          verificationState: "assistant_inferred",
          sourceType: "extraction",
          sourceMessageRole: "assistant",
          scopeId: "default",
          firstSeenAt: now + 10,
          lastSeenAt: now + 10,
        },
        {
          id: "item-user-reported",
          kind: "preference",
          subject: "notification pref",
          statement: "User prefers email notifications.",
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: "fp-user-reported",
          verificationState: "user_reported",
          sourceType: "extraction",
          sourceMessageRole: "user",
          scopeId: "default",
          firstSeenAt: now + 20,
          lastSeenAt: now + 20,
        },
        {
          id: "item-other-conv",
          kind: "fact",
          subject: "weather check",
          statement: "Checked weather for tomorrow.",
          status: "active",
          confidence: 0.7,
          importance: 0.5,
          fingerprint: "fp-other-conv",
          verificationState: "assistant_inferred",
          sourceType: "extraction",
          sourceMessageRole: "assistant",
          scopeId: "default",
          firstSeenAt: now + 30,
          lastSeenAt: now + 30,
        },
        {
          id: "item-already-superseded",
          kind: "fact",
          subject: "old claim",
          statement: "Old assistant claim already superseded.",
          status: "superseded",
          confidence: 0.6,
          importance: 0.4,
          fingerprint: "fp-already-superseded",
          verificationState: "assistant_inferred",
          sourceType: "extraction",
          sourceMessageRole: "assistant",
          scopeId: "default",
          firstSeenAt: now + 5,
          lastSeenAt: now + 5,
        },
      ])
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-assistant-inferred",
          messageId: "msg-task-1",
          evidence: "booking claim",
          createdAt: now + 10,
        },
        {
          memoryItemId: "item-user-reported",
          messageId: "msg-task-2",
          evidence: "user stated",
          createdAt: now + 20,
        },
        {
          memoryItemId: "item-other-conv",
          messageId: "msg-other",
          evidence: "weather",
          createdAt: now + 30,
        },
        {
          memoryItemId: "item-already-superseded",
          messageId: "msg-task-1",
          evidence: "old claim",
          createdAt: now + 5,
        },
      ])
      .run();
  }

  test("only invalidates assistant_inferred items, not user_reported", () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    expect(affected).toBe(1);

    const db = getDb();
    const assistantItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-assistant-inferred"))
      .get();
    expect(assistantItem?.status).toBe("invalidated");
    expect(assistantItem?.invalidAt).not.toBeNull();

    const userItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-user-reported"))
      .get();
    expect(userItem?.status).toBe("active");
    expect(userItem?.invalidAt).toBeNull();
  });

  test("does not affect items from other conversations", () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const otherItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-other-conv"))
      .get();
    expect(otherItem?.status).toBe("active");
    expect(otherItem?.invalidAt).toBeNull();
  });

  test("does not invalidate items also sourced from another conversation", () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    // Add a second source from the other conversation to the assistant-inferred item.
    // This simulates deduplication: the same fact was extracted from both conversations.
    const db = getDb();
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-assistant-inferred",
        messageId: "msg-other",
        evidence: "corroborating source from other conversation",
        createdAt: now + 40,
      })
      .run();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    // The item has sources from both conversations, so it should NOT be invalidated.
    expect(affected).toBe(0);

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-assistant-inferred"))
      .get();
    expect(item?.status).toBe("active");
    expect(item?.invalidAt).toBeNull();
  });

  test("does not affect already-superseded items", () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const supersededItem = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-already-superseded"))
      .get();
    expect(supersededItem?.status).toBe("superseded");
  });

  test("returns 0 when no matching items exist", () => {
    seedConversations();
    seedMessages();
    // No memory items seeded

    const affected = invalidateAssistantInferredItemsForConversation(convId);
    expect(affected).toBe(0);
  });

  test("returns 0 for unknown conversation", () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

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

    // A memory item sourced from both conversations
    db.insert(memoryItems)
      .values({
        id: "item-cross-sourced",
        kind: "fact",
        subject: "cross-sourced claim",
        statement: "Claim from two failed tasks.",
        status: "active",
        confidence: 0.8,
        importance: 0.7,
        fingerprint: "fp-cross-sourced",
        verificationState: "assistant_inferred",
        sourceType: "extraction",
        sourceMessageRole: "assistant",
        scopeId: "default",
        firstSeenAt: now + 10,
        lastSeenAt: now + 20,
      })
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-cross-sourced",
          messageId: "msg-a",
          evidence: "claim from A",
          createdAt: now + 10,
        },
        {
          memoryItemId: "item-cross-sourced",
          messageId: "msg-b",
          evidence: "claim from B",
          createdAt: now + 20,
        },
      ])
      .run();

    // Invalidating for convA should succeed because convB is also from a failed task
    const affected = invalidateAssistantInferredItemsForConversation(convA);
    expect(affected).toBe(1);

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-cross-sourced"))
      .get();
    expect(item?.status).toBe("invalidated");
    expect(item?.invalidAt).not.toBeNull();
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

    db.insert(memoryItems)
      .values({
        id: "item-cross-sched",
        kind: "fact",
        subject: "cross-sourced schedule claim",
        statement: "Claim from two failed schedules.",
        status: "active",
        confidence: 0.8,
        importance: 0.7,
        fingerprint: "fp-cross-sched",
        verificationState: "assistant_inferred",
        sourceType: "extraction",
        sourceMessageRole: "assistant",
        scopeId: "default",
        firstSeenAt: now + 10,
        lastSeenAt: now + 20,
      })
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-cross-sched",
          messageId: "msg-sched-a",
          evidence: "claim from A",
          createdAt: now + 10,
        },
        {
          memoryItemId: "item-cross-sched",
          messageId: "msg-sched-b",
          evidence: "claim from B",
          createdAt: now + 20,
        },
      ])
      .run();

    const affected = invalidateAssistantInferredItemsForConversation(convA);
    expect(affected).toBe(1);

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-cross-sched"))
      .get();
    expect(item?.status).toBe("invalidated");
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

    db.insert(memoryItems)
      .values({
        id: "item-with-good-corroboration",
        kind: "fact",
        subject: "corroborated claim",
        statement: "Claim corroborated by successful task.",
        status: "active",
        confidence: 0.8,
        importance: 0.7,
        fingerprint: "fp-good-corroboration",
        verificationState: "assistant_inferred",
        sourceType: "extraction",
        sourceMessageRole: "assistant",
        scopeId: "default",
        firstSeenAt: now + 10,
        lastSeenAt: now + 20,
      })
      .run();

    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-with-good-corroboration",
          messageId: "msg-failed",
          evidence: "claim from failed",
          createdAt: now + 10,
        },
        {
          memoryItemId: "item-with-good-corroboration",
          messageId: "msg-success",
          evidence: "claim from success",
          createdAt: now + 20,
        },
      ])
      .run();

    // The successful task run corroborates the claim, so it should NOT be invalidated
    const affected =
      invalidateAssistantInferredItemsForConversation(convFailed);
    expect(affected).toBe(0);

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, "item-with-good-corroboration"))
      .get();
    expect(item?.status).toBe("active");
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

  test("cancels pending extract_items jobs for the failed conversation", () => {
    seedConversations();
    seedMessages();

    const db = getDb();

    // Enqueue extract_items jobs for messages in the target conversation
    enqueueMemoryJob("extract_items", {
      messageId: "msg-task-1",
      scopeId: "default",
    });
    enqueueMemoryJob("extract_items", {
      messageId: "msg-task-2",
      scopeId: "default",
    });
    // Enqueue an extract_items job for a message in a different conversation
    enqueueMemoryJob("extract_items", {
      messageId: "msg-other",
      scopeId: "default",
    });

    // Verify all jobs are pending
    const pendingBefore = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();
    expect(pendingBefore.filter((j) => j.status === "pending")).toHaveLength(3);

    invalidateAssistantInferredItemsForConversation(convId);

    // Jobs for the failed conversation should be cancelled (failed)
    const allJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
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
    expect(payload.messageId).toBe("msg-other");
  });
});
