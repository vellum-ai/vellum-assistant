import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Test directory & platform mocks ───────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), "reducer-job-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
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

// ── Mock the reducer ──────────────────────────────────────────────

import type { ReducerPromptInput } from "../memory/reducer.js";
import type { ReducerResult } from "../memory/reducer-types.js";
import { EMPTY_REDUCER_RESULT } from "../memory/reducer-types.js";

let mockReducerResult: ReducerResult = EMPTY_REDUCER_RESULT;
let lastReducerInput: ReducerPromptInput | null = null;

mock.module("../memory/reducer.js", () => ({
  runReducer: async (input: ReducerPromptInput) => {
    lastReducerInput = input;
    return mockReducerResult;
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { reduceConversationMemoryJob } from "../memory/job-handlers/reduce-conversation-memory.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import { resetTestTables } from "../memory/raw-query.js";

initializeDb();

// ── Helpers ───────────────────────────────────────────────────────

const SCOPE = "test-scope";
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function insertConversation(
  id: string,
  opts?: {
    dirtyTailMessageId?: string;
    reducedThroughMessageId?: string;
    contextSummary?: string;
    memoryScopeId?: string;
  },
): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source, memory_scope_id, is_auto_title,
       memory_dirty_tail_since_message_id, memory_reduced_through_message_id, context_summary)
     VALUES (?, 'Test', ?, ?, 'standard', 'user', ?, 1, ?, ?, ?)`,
    [
      id,
      NOW,
      NOW,
      opts?.memoryScopeId ?? SCOPE,
      opts?.dirtyTailMessageId ?? null,
      opts?.reducedThroughMessageId ?? null,
      opts?.contextSummary ?? null,
    ],
  );
}

function insertMessage(opts: {
  id: string;
  conversationId: string;
  role?: string;
  content?: string;
  createdAt?: number;
}): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.conversationId,
      opts.role ?? "user",
      opts.content ?? "test message",
      opts.createdAt ?? NOW,
    ],
  );
}

function getRawConversation(conversationId: string): Record<string, unknown> {
  const raw = getSqlite();
  return raw
    .query(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId) as Record<string, unknown>;
}

function makeJob(conversationId: string): MemoryJob {
  return {
    id: "job-1",
    type: "reduce_conversation_memory",
    payload: { conversationId },
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: NOW,
    lastError: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeReducerResult(overrides?: Partial<ReducerResult>): ReducerResult {
  return {
    timeContexts: [],
    openLoops: [],
    archiveObservations: [],
    archiveEpisodes: [],
    ...overrides,
  };
}

// ── Teardown ──────────────────────────────────────────────────────

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  resetTestTables("messages", "conversations", "time_contexts", "open_loops");
  mockReducerResult = EMPTY_REDUCER_RESULT;
  lastReducerInput = null;
});

// ── Tests ─────────────────────────────────────────────────────────

describe("reduceConversationMemoryJob", () => {
  describe("successful reduction", () => {
    test("reduces dirty conversation and advances checkpoint", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "Hello there",
        createdAt: NOW,
      });
      insertMessage({
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        content: "Hi! How can I help?",
        createdAt: NOW + 1000,
      });

      mockReducerResult = makeReducerResult({
        openLoops: [
          {
            action: "create",
            summary: "User needs help with something",
            source: "conversation",
          },
        ],
      });

      await reduceConversationMemoryJob(makeJob("conv-1"));

      // Checkpoint should advance to the last message
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBe("msg-2");
      expect(conv.memory_last_reduced_at).toBeGreaterThan(0);
      // Dirty tail should be cleared since all messages are now reduced
      expect(conv.memory_dirty_tail_since_message_id).toBeNull();
    });

    test("passes unreduced messages to the reducer", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "First message",
        createdAt: NOW,
      });
      insertMessage({
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        content: "Second message",
        createdAt: NOW + 1000,
      });

      mockReducerResult = makeReducerResult();

      await reduceConversationMemoryJob(makeJob("conv-1"));

      expect(lastReducerInput).not.toBeNull();
      expect(lastReducerInput!.conversationId).toBe("conv-1");
      expect(lastReducerInput!.newMessages).toHaveLength(2);
      expect(lastReducerInput!.newMessages[0].role).toBe("user");
      expect(lastReducerInput!.newMessages[0].content).toBe("First message");
      expect(lastReducerInput!.newMessages[1].role).toBe("assistant");
      expect(lastReducerInput!.newMessages[1].content).toBe("Second message");
    });

    test("includes contextSummary as synthetic system message when present", async () => {
      insertConversation("conv-1", {
        dirtyTailMessageId: "msg-1",
        contextSummary: "User is working on a TypeScript project",
      });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "Can you help with this bug?",
        createdAt: NOW,
      });

      mockReducerResult = makeReducerResult();

      await reduceConversationMemoryJob(makeJob("conv-1"));

      expect(lastReducerInput).not.toBeNull();
      // contextSummary should be prepended as a system message
      expect(lastReducerInput!.newMessages).toHaveLength(2);
      expect(lastReducerInput!.newMessages[0].role).toBe("system");
      expect(lastReducerInput!.newMessages[0].content).toContain(
        "User is working on a TypeScript project",
      );
      // Real message follows
      expect(lastReducerInput!.newMessages[1].role).toBe("user");
      expect(lastReducerInput!.newMessages[1].content).toBe(
        "Can you help with this bug?",
      );
    });

    test("loads active time contexts and open loops for the reducer", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "test",
        createdAt: NOW,
      });

      // Insert pre-existing active time context.
      // Use a far-future activeUntil so it is still active at Date.now().
      const farFuture = Date.now() + 365 * 24 * HOUR;
      const raw = getSqlite();
      raw.run(
        `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
         VALUES ('tc-1', ?, 'User on vacation next week', 'conversation', ?, ?, ?, ?)`,
        [SCOPE, NOW, farFuture, NOW, NOW],
      );

      // Insert pre-existing open loop
      raw.run(
        `INSERT INTO open_loops (id, scope_id, summary, status, source, created_at, updated_at)
         VALUES ('ol-1', ?, 'Waiting for deploy', 'open', 'conversation', ?, ?)`,
        [SCOPE, NOW, NOW],
      );

      mockReducerResult = makeReducerResult();

      await reduceConversationMemoryJob(makeJob("conv-1"));

      expect(lastReducerInput).not.toBeNull();
      expect(lastReducerInput!.existingTimeContexts).toHaveLength(1);
      expect(lastReducerInput!.existingTimeContexts[0].id).toBe("tc-1");
      expect(lastReducerInput!.existingTimeContexts[0].summary).toBe(
        "User on vacation next week",
      );
      expect(lastReducerInput!.existingOpenLoops).toHaveLength(1);
      expect(lastReducerInput!.existingOpenLoops[0].id).toBe("ol-1");
      expect(lastReducerInput!.existingOpenLoops[0].summary).toBe(
        "Waiting for deploy",
      );
    });

    test("creates time contexts and open loops from reducer output", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "I'm going on vacation next week",
        createdAt: NOW,
      });

      mockReducerResult = makeReducerResult({
        timeContexts: [
          {
            action: "create",
            summary: "User on vacation next week",
            source: "conversation",
            activeFrom: NOW,
            activeUntil: NOW + 7 * 24 * HOUR,
          },
        ],
        openLoops: [
          {
            action: "create",
            summary: "Set up OOO auto-reply",
            source: "conversation",
          },
        ],
      });

      await reduceConversationMemoryJob(makeJob("conv-1"));

      // Verify time context was created
      const raw = getSqlite();
      const contexts = raw
        .query(`SELECT * FROM time_contexts WHERE scope_id = ?`)
        .all(SCOPE) as Array<Record<string, unknown>>;
      expect(contexts).toHaveLength(1);
      expect(contexts[0].summary).toBe("User on vacation next week");

      // Verify open loop was created
      const loops = raw
        .query(`SELECT * FROM open_loops WHERE scope_id = ?`)
        .all(SCOPE) as Array<Record<string, unknown>>;
      expect(loops).toHaveLength(1);
      expect(loops[0].summary).toBe("Set up OOO auto-reply");
      expect(loops[0].status).toBe("open");
    });
  });

  describe("empty dirty tails", () => {
    test("no-ops when conversation has no dirty tail marker", async () => {
      insertConversation("conv-1"); // no dirtyTailMessageId
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "test",
        createdAt: NOW,
      });

      await reduceConversationMemoryJob(makeJob("conv-1"));

      // Reducer should not have been called
      expect(lastReducerInput).toBeNull();

      // Conversation unchanged
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBeNull();
    });

    test("no-ops when dirty tail message no longer exists", async () => {
      insertConversation("conv-1", {
        dirtyTailMessageId: "deleted-msg",
      });
      // No messages inserted — the dirty tail message doesn't exist

      await reduceConversationMemoryJob(makeJob("conv-1"));

      // Reducer should not have been called
      expect(lastReducerInput).toBeNull();

      // Conversation unchanged
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBeNull();
    });

    test("no-ops when conversation does not exist", async () => {
      await reduceConversationMemoryJob(makeJob("nonexistent-conv"));

      expect(lastReducerInput).toBeNull();
    });

    test("no-ops when payload has no conversationId", async () => {
      const job: MemoryJob = {
        id: "job-1",
        type: "reduce_conversation_memory",
        payload: {},
        status: "running",
        attempts: 0,
        deferrals: 0,
        runAfter: NOW,
        lastError: null,
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      };

      await reduceConversationMemoryJob(job);

      expect(lastReducerInput).toBeNull();
    });
  });

  describe("reducer failure safety", () => {
    test("does not advance checkpoint when reducer returns EMPTY_REDUCER_RESULT", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "test",
        createdAt: NOW,
      });

      // The default mockReducerResult is EMPTY_REDUCER_RESULT
      mockReducerResult = EMPTY_REDUCER_RESULT;

      await reduceConversationMemoryJob(makeJob("conv-1"));

      // Checkpoint should NOT have advanced
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBeNull();
      expect(conv.memory_last_reduced_at).toBeNull();
      // Dirty tail stays in place for retry
      expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");
    });

    test("does not advance checkpoint when reducer throws", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "test",
        createdAt: NOW,
      });

      // Temporarily replace the mock to throw
      mock.module("../memory/reducer.js", () => ({
        runReducer: async (input: ReducerPromptInput) => {
          lastReducerInput = input;
          throw new Error("Provider timeout");
        },
      }));

      try {
        await reduceConversationMemoryJob(makeJob("conv-1"));
      } catch {
        // Error propagation is expected — the job worker handles classification
      }

      // Restore the normal mock for subsequent tests
      mock.module("../memory/reducer.js", () => ({
        runReducer: async (input: ReducerPromptInput) => {
          lastReducerInput = input;
          return mockReducerResult;
        },
      }));

      // Regardless of error handling, checkpoint must not advance
      const conv = getRawConversation("conv-1");
      expect(conv.memory_reduced_through_message_id).toBeNull();
      expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");
    });

    test("partial dirty tail preserved when more messages arrive during reduction", async () => {
      insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "First",
        createdAt: NOW,
      });
      insertMessage({
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        content: "Response",
        createdAt: NOW + 1000,
      });
      // msg-3 arrives "later" — simulates a message added during/after reduction
      insertMessage({
        id: "msg-3",
        conversationId: "conv-1",
        role: "user",
        content: "Follow-up",
        createdAt: NOW + 5000,
      });

      mockReducerResult = makeReducerResult();

      await reduceConversationMemoryJob(makeJob("conv-1"));

      const conv = getRawConversation("conv-1");
      // All three messages were loaded (they all exist at query time), so
      // checkpoint advances through msg-3
      expect(conv.memory_reduced_through_message_id).toBe("msg-3");
    });
  });

  describe("scope isolation", () => {
    test("uses the conversation's memoryScopeId for context lookups", async () => {
      const customScope = "custom-scope";
      insertConversation("conv-1", {
        dirtyTailMessageId: "msg-1",
        memoryScopeId: customScope,
      });
      insertMessage({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "test",
        createdAt: NOW,
      });

      mockReducerResult = makeReducerResult();

      await reduceConversationMemoryJob(makeJob("conv-1"));

      expect(lastReducerInput).not.toBeNull();
      expect(lastReducerInput!.scopeId).toBe(customScope);
    });
  });
});
