import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Test directory & platform mocks ───────────────────────────────

const testDir = mkdtempSync(
  join(tmpdir(), "conversation-switch-memory-reduction-test-"),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  getWorkspaceDir: () => join(testDir, "workspace"),
  getConversationsDir: () => join(testDir, "workspace", "conversations"),
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

// ── Config mock ───────────────────────────────────────────────────

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      simplified: {
        reducer: {
          idleDelayMs: 30_000,
          switchWaitMs: 5_000,
        },
      },
    },
  }),
  loadConfig: () => ({
    memory: {
      simplified: {
        reducer: {
          idleDelayMs: 30_000,
          switchWaitMs: 5_000,
        },
      },
    },
  }),
}));

// ── Suppress disk-view side effects ──────────────────────────────

mock.module("../memory/conversation-disk-view.js", () => ({
  initConversationDir: () => {},
  removeConversationDir: () => {},
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

// ── Suppress indexer side effects ────────────────────────────────

mock.module("../memory/indexer.js", () => ({
  indexMessageNow: async () => {},
}));

// ── Suppress attention side effects ──────────────────────────────

mock.module("../memory/conversation-attention-store.js", () => ({
  projectAssistantMessage: () => {},
  seedForkedConversationAttention: () => {},
}));

// ── Mock the reducer ──────────────────────────────────────────────

import type { ReducerPromptInput } from "../memory/reducer.js";
import type { ReducerResult } from "../memory/reducer-types.js";
import { EMPTY_REDUCER_RESULT } from "../memory/reducer-types.js";

let mockReducerResult: ReducerResult = EMPTY_REDUCER_RESULT;
let lastReducerInput: ReducerPromptInput | null = null;
let reducerCallCount = 0;

mock.module("../memory/reducer.js", () => ({
  runReducer: async (input: ReducerPromptInput) => {
    lastReducerInput = input;
    reducerCallCount++;
    return mockReducerResult;
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { resetTestTables } from "../memory/raw-query.js";
import {
  findMostRecentDirtyConversation,
  reduceBeforeSwitch,
} from "../memory/reducer-scheduler.js";

initializeDb();

// ── Helpers ───────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const SCOPE = "default";

function insertConversation(
  id: string,
  opts?: {
    dirtyTailMessageId?: string | null;
    updatedAt?: number;
    memoryScopeId?: string;
    contextSummary?: string;
  },
): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source, memory_scope_id, is_auto_title,
       memory_dirty_tail_since_message_id, context_summary)
     VALUES (?, 'Test', ?, ?, 'standard', 'user', ?, 1, ?, ?)`,
    [
      id,
      NOW,
      opts?.updatedAt ?? NOW,
      opts?.memoryScopeId ?? SCOPE,
      opts?.dirtyTailMessageId ?? null,
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
  resetTestTables(
    "messages",
    "conversations",
    "memory_jobs",
    "time_contexts",
    "open_loops",
  );
  mockReducerResult = EMPTY_REDUCER_RESULT;
  lastReducerInput = null;
  reducerCallCount = 0;
});

// ── Tests ─────────────────────────────────────────────────────────

describe("findMostRecentDirtyConversation", () => {
  test("returns the most recently updated dirty conversation", () => {
    insertConversation("conv-old", {
      dirtyTailMessageId: "msg-old",
      updatedAt: NOW - 5000,
    });
    insertConversation("conv-recent", {
      dirtyTailMessageId: "msg-recent",
      updatedAt: NOW,
    });
    insertConversation("conv-target", { updatedAt: NOW + 1000 });

    const result = findMostRecentDirtyConversation("conv-target");
    // Should return the most recently updated dirty conversation (ordered by updatedAt DESC)
    expect(result).toBe("conv-recent");
  });

  test("excludes the target conversation", () => {
    insertConversation("conv-dirty", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });

    const result = findMostRecentDirtyConversation("conv-dirty");
    expect(result).toBeNull();
  });

  test("returns null when no dirty conversations exist", () => {
    insertConversation("conv-clean", { updatedAt: NOW });

    const result = findMostRecentDirtyConversation("conv-target");
    expect(result).toBeNull();
  });

  test("returns null when only dirty conversation is the target", () => {
    insertConversation("conv-target", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertConversation("conv-clean", { updatedAt: NOW + 1000 });

    const result = findMostRecentDirtyConversation("conv-target");
    expect(result).toBeNull();
  });
});

describe("reduceBeforeSwitch — conversation switch", () => {
  test("reduces the dirty conversation before switching", async () => {
    // Previous conversation with dirty messages
    insertConversation("conv-prev", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-prev",
      role: "user",
      content: "Hello",
      createdAt: NOW,
    });
    insertMessage({
      id: "msg-2",
      conversationId: "conv-prev",
      role: "assistant",
      content: "Hi there!",
      createdAt: NOW + 1000,
    });

    // Target conversation
    insertConversation("conv-target", { updatedAt: NOW + 5000 });

    mockReducerResult = makeReducerResult({
      openLoops: [
        {
          action: "create",
          summary: "User greeted the assistant",
          source: "conversation",
        },
      ],
    });

    const result = await reduceBeforeSwitch("conv-target");

    // Should have reduced conv-prev
    expect(result).toBe("conv-prev");
    expect(reducerCallCount).toBe(1);

    // Checkpoint should be advanced
    const conv = getRawConversation("conv-prev");
    expect(conv.memory_reduced_through_message_id).toBe("msg-2");
    expect(conv.memory_dirty_tail_since_message_id).toBeNull();
  });

  test("skips when no eligible dirty conversation exists", async () => {
    insertConversation("conv-clean", { updatedAt: NOW });
    insertConversation("conv-target", { updatedAt: NOW + 1000 });

    const result = await reduceBeforeSwitch("conv-target");

    expect(result).toBeNull();
    expect(reducerCallCount).toBe(0);
  });

  test("skips when the only dirty conversation is the target", async () => {
    insertConversation("conv-target", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertMessage({ id: "msg-1", conversationId: "conv-target" });

    const result = await reduceBeforeSwitch("conv-target");

    expect(result).toBeNull();
    expect(reducerCallCount).toBe(0);
  });

  test("does not advance checkpoint when reducer returns empty result", async () => {
    insertConversation("conv-prev", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-prev",
      role: "user",
      content: "Hello",
      createdAt: NOW,
    });
    insertConversation("conv-target", { updatedAt: NOW + 5000 });

    mockReducerResult = EMPTY_REDUCER_RESULT;

    const result = await reduceBeforeSwitch("conv-target");

    // Returns null because empty result means nothing was reduced
    expect(result).toBeNull();

    // Checkpoint should NOT advance
    const conv = getRawConversation("conv-prev");
    expect(conv.memory_reduced_through_message_id).toBeNull();
    expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");
  });
});

describe("reduceBeforeSwitch — new conversation", () => {
  test("reduces the previous dirty conversation when starting a new one", async () => {
    insertConversation("conv-prev", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-prev",
      role: "user",
      content: "Some prior work",
      createdAt: NOW,
    });

    // The new conversation ID (just created)
    const newConvId = "conv-new";
    insertConversation(newConvId, { updatedAt: NOW + 5000 });

    mockReducerResult = makeReducerResult({
      timeContexts: [
        {
          action: "create",
          summary: "Prior work in progress",
          source: "conversation",
          activeFrom: NOW,
          activeUntil: NOW + 7 * 24 * 60 * 60 * 1000,
        },
      ],
    });

    const result = await reduceBeforeSwitch(newConvId);

    expect(result).toBe("conv-prev");
    expect(reducerCallCount).toBe(1);

    // Verify the previous conversation's checkpoint was advanced
    const conv = getRawConversation("conv-prev");
    expect(conv.memory_reduced_through_message_id).toBe("msg-1");
    expect(conv.memory_dirty_tail_since_message_id).toBeNull();
  });
});

describe("reduceBeforeSwitch — most recent dirty selection", () => {
  test("selects the most recently updated dirty conversation when multiple exist", async () => {
    // Two dirty conversations — conv-newer is more recently updated
    insertConversation("conv-older", {
      dirtyTailMessageId: "msg-older",
      updatedAt: NOW - 10_000,
    });
    insertMessage({
      id: "msg-older",
      conversationId: "conv-older",
      role: "user",
      content: "Older conversation",
      createdAt: NOW - 10_000,
    });

    insertConversation("conv-newer", {
      dirtyTailMessageId: "msg-newer",
      updatedAt: NOW,
    });
    insertMessage({
      id: "msg-newer",
      conversationId: "conv-newer",
      role: "user",
      content: "Newer conversation",
      createdAt: NOW,
    });

    insertConversation("conv-target", { updatedAt: NOW + 5000 });

    mockReducerResult = makeReducerResult();

    // Even though two are dirty, we only reduce one per switch.
    // The function picks the most recently updated (by updatedAt DESC).
    const result = await reduceBeforeSwitch("conv-target");

    // Should pick the most recently updated dirty conversation
    expect(result).toBe("conv-newer");
    expect(reducerCallCount).toBe(1);
    expect(lastReducerInput?.conversationId).toBe("conv-newer");
  });
});

describe("reduceBeforeSwitch — error handling", () => {
  test("returns null and continues when reducer throws", async () => {
    insertConversation("conv-prev", {
      dirtyTailMessageId: "msg-1",
      updatedAt: NOW,
    });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-prev",
      role: "user",
      content: "Hello",
      createdAt: NOW,
    });
    insertConversation("conv-target", { updatedAt: NOW + 5000 });

    // Override mock to throw
    mock.module("../memory/reducer.js", () => ({
      runReducer: async () => {
        reducerCallCount++;
        throw new Error("Provider timeout");
      },
    }));

    const result = await reduceBeforeSwitch("conv-target");

    // Should return null (graceful failure, don't block the switch)
    expect(result).toBeNull();

    // Checkpoint should NOT advance
    const conv = getRawConversation("conv-prev");
    expect(conv.memory_reduced_through_message_id).toBeNull();
    expect(conv.memory_dirty_tail_since_message_id).toBe("msg-1");

    // Restore normal mock for subsequent tests
    mock.module("../memory/reducer.js", () => ({
      runReducer: async (input: ReducerPromptInput) => {
        lastReducerInput = input;
        reducerCallCount++;
        return mockReducerResult;
      },
    }));
  });
});
