/**
 * Tests for the simplified memory runtime injection path in
 * conversation-memory.ts.
 *
 * Covers:
 * - Brief-only turns (no archive recall trigger)
 * - Brief-plus-recall turns (archive recall fires)
 * - Disabled-flag fallback (legacy path used when flag is off)
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

const testDir = mkdtempSync(join(tmpdir(), "simplified-memory-runtime-test-"));
const dbPath = join(testDir, "test.db");

// ── Platform mock (must come before any module imports) ──────────────

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => dbPath,
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// ── Configurable config mock ────────────────────────────────────────

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

let testConfig: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    simplified: {
      ...DEFAULT_CONFIG.memory.simplified,
      enabled: true,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => testConfig,
  getConfig: () => testConfig,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Stub out the legacy retriever to ensure the simplified path does not
// call into the heavy V2 hybrid pipeline. If the legacy path is used
// unexpectedly, the test will fail with a clear error.
//
// We provide the real `injectMemoryRecallAsUserBlock` inline since
// it's a pure function used by both the legacy and simplified paths.
mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: () => {
    throw new Error(
      "buildMemoryRecall should not be called in simplified mode",
    );
  },
  injectMemoryRecallAsUserBlock: (
    msgs: import("../providers/types.js").Message[],
    memoryRecallText: string,
  ): import("../providers/types.js").Message[] => {
    if (memoryRecallText.trim().length === 0) return msgs;
    if (msgs.length === 0) return msgs;
    const userTail = msgs[msgs.length - 1];
    if (!userTail || userTail.role !== "user") return msgs;
    return [
      ...msgs.slice(0, -1),
      {
        ...userTail,
        content: [
          { type: "text" as const, text: memoryRecallText },
          ...userTail.content,
        ],
      },
    ];
  },
}));

// Stub out modules used only by the legacy pipeline (budget, token
// estimator, query builder) so they never execute in simplified mode.
mock.module("../memory/query-builder.js", () => ({
  buildMemoryQuery: () => {
    throw new Error("buildMemoryQuery should not be called in simplified mode");
  },
}));
mock.module("../memory/retrieval-budget.js", () => ({
  computeRecallBudget: () => {
    throw new Error(
      "computeRecallBudget should not be called in simplified mode",
    );
  },
}));
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => 0,
}));

// ── Now import the module under test ────────────────────────────────

import { v4 as uuid } from "uuid";

import {
  type MemoryPrepareContext,
  prepareMemoryContext,
} from "../daemon/conversation-memory.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  insertCompactionEpisode,
  insertObservation,
} from "../memory/archive-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { conversations, messages } from "../memory/schema.js";
import type { Message } from "../providers/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function getRawDb(): import("bun:sqlite").Database {
  return getSqlite();
}

function insertTimeContext(opts: {
  id: string;
  summary: string;
  activeFrom: number;
  activeUntil: number;
  scopeId?: string;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO time_contexts (id, scope_id, summary, source, active_from, active_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.scopeId ?? "default",
      opts.summary,
      "conversation",
      opts.activeFrom,
      opts.activeUntil,
      now,
      now,
    ],
  );
}

function insertOpenLoop(opts: {
  id: string;
  summary: string;
  dueAt?: number | null;
  updatedAt?: number;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO open_loops (id, scope_id, summary, status, source, due_at, surfaced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'conversation', ?, ?, ?, ?)`,
    [
      opts.id,
      "default",
      opts.summary,
      "open",
      opts.dueAt ?? null,
      null,
      now,
      opts.updatedAt ?? now,
    ],
  );
}

function createConversation(id: string, title: string | null = null): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function createMessage(
  id: string,
  conversationId: string,
  role: string = "user",
  content: string = "test message",
): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content,
      createdAt: Date.now(),
    })
    .run();
}

function makeUserMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function buildCtx(
  overrides: Partial<MemoryPrepareContext> = {},
): MemoryPrepareContext {
  return {
    conversationId: uuid(),
    messages: [makeUserMessage("Hello")],
    systemPrompt: "",
    provider: { name: "anthropic" } as MemoryPrepareContext["provider"],
    scopeId: "default",
    includeDefaultFallback: true,
    trustClass: "guardian",
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── Setup / Teardown ────────────────────────────────────────────────

describe("Simplified Memory Runtime", () => {
  const events: ServerMessage[] = [];
  const onEvent = (msg: ServerMessage) => events.push(msg);
  const abortController = new AbortController();

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    events.length = 0;
    resetDb();
    removeTestDbFiles();
    initializeDb();
    // Reset config to simplified-enabled for each test
    testConfig = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        enabled: true,
        simplified: {
          ...DEFAULT_CONFIG.memory.simplified,
          enabled: true,
        },
      },
    };
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── Brief-only turns ────────────────────────────────────────────

  describe("brief-only turns", () => {
    test("injects <memory_brief> when time context exists", async () => {
      const now = Date.now();
      insertTimeContext({
        id: "tc-1",
        summary: "Deploy to staging at 3pm",
        activeFrom: now - HOUR,
        activeUntil: now + 2 * HOUR,
      });

      const ctx = buildCtx({
        messages: [makeUserMessage("What should I be working on?")],
      });
      const msgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "What should I be working on?",
        msgId,
        abortController.signal,
        onEvent,
      );

      // Should have injected memory_brief into the last user message
      const lastMsg = result.runMessages[result.runMessages.length - 1];
      expect(lastMsg.role).toBe("user");
      const textBlocks = lastMsg.content.filter((b) => b.type === "text");
      const injectedText = textBlocks
        .map((b) => ("text" in b ? b.text : ""))
        .join("\n");

      expect(injectedText).toContain("<memory_brief>");
      expect(injectedText).toContain("Deploy to staging at 3pm");
      expect(injectedText).toContain("</memory_brief>");

      // Should NOT contain <supporting_recall> (no archive data or trigger)
      expect(injectedText).not.toContain("<supporting_recall>");

      // Should have emitted memory_status
      expect(events.some((e) => e.type === "memory_status")).toBe(true);
    });

    test("injects <memory_brief> with open loops", async () => {
      const now = Date.now();
      insertOpenLoop({
        id: "ol-1",
        summary: "Review the PR for the auth refactor",
        dueAt: now + 6 * HOUR,
        updatedAt: now - DAY * 10,
      });

      const ctx = buildCtx({
        messages: [makeUserMessage("What are my pending tasks?")],
      });
      const msgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "What are my pending tasks?",
        msgId,
        abortController.signal,
        onEvent,
      );

      const lastMsg = result.runMessages[result.runMessages.length - 1];
      const textBlocks = lastMsg.content.filter((b) => b.type === "text");
      const injectedText = textBlocks
        .map((b) => ("text" in b ? b.text : ""))
        .join("\n");

      expect(injectedText).toContain("<memory_brief>");
      expect(injectedText).toContain("Review the PR for the auth refactor");
      expect(injectedText).toContain("</memory_brief>");
    });

    test("returns unmodified messages when brief is empty and no recall", async () => {
      // No time contexts or open loops — brief will be empty
      const ctx = buildCtx({
        messages: [makeUserMessage("Write a function to sort an array")],
      });
      const msgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "Write a function to sort an array",
        msgId,
        abortController.signal,
        onEvent,
      );

      // Messages should be unmodified
      expect(result.runMessages).toEqual(ctx.messages);
      expect(result.recall.injectedText).toBe("");
    });
  });

  // ── Brief-plus-recall turns ─────────────────────────────────────

  describe("brief-plus-recall turns", () => {
    test("injects both <memory_brief> and <supporting_recall>", async () => {
      const now = Date.now();

      // Seed time context for the brief
      insertTimeContext({
        id: "tc-1",
        summary: "Code review session at 4pm",
        activeFrom: now - HOUR,
        activeUntil: now + 3 * HOUR,
      });

      // Seed archive data that will trigger recall
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId, "Authentication Discussion");
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content:
          "User wants to migrate authentication from JWT to session tokens",
        scopeId: "default",
      });

      const ctx = buildCtx({
        messages: [
          makeUserMessage(
            "Do you remember what we discussed about authentication?",
          ),
        ],
      });
      const userMsgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "Do you remember what we discussed about authentication?",
        userMsgId,
        abortController.signal,
        onEvent,
      );

      const lastMsg = result.runMessages[result.runMessages.length - 1];
      const textBlocks = lastMsg.content.filter((b) => b.type === "text");
      const injectedText = textBlocks
        .map((b) => ("text" in b ? b.text : ""))
        .join("\n");

      // Both blocks should be present
      expect(injectedText).toContain("<memory_brief>");
      expect(injectedText).toContain("Code review session at 4pm");
      expect(injectedText).toContain("</memory_brief>");
      expect(injectedText).toContain("<supporting_recall>");
      expect(injectedText).toContain("authentication");
      expect(injectedText).toContain("</supporting_recall>");
    });

    test("injects only <supporting_recall> when brief is empty but recall triggers", async () => {
      // No time contexts or open loops, so brief is empty
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId, "Database Planning");
      createMessage(msgId, convId);

      insertCompactionEpisode({
        scopeId: "default",
        conversationId: convId,
        title: "PostgreSQL Migration",
        summary:
          "Discussed migrating from MySQL to PostgreSQL with a phased approach",
        tokenEstimate: 25,
        startAt: Date.now() - DAY,
        endAt: Date.now() - 12 * HOUR,
      });

      const ctx = buildCtx({
        messages: [
          makeUserMessage("Do you remember the PostgreSQL migration plan?"),
        ],
      });
      const userMsgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "Do you remember the PostgreSQL migration plan?",
        userMsgId,
        abortController.signal,
        onEvent,
      );

      const lastMsg = result.runMessages[result.runMessages.length - 1];
      const textBlocks = lastMsg.content.filter((b) => b.type === "text");
      const injectedText = textBlocks
        .map((b) => ("text" in b ? b.text : ""))
        .join("\n");

      // Brief should not be present (empty)
      expect(injectedText).not.toContain("<memory_brief>");
      // Recall should be present
      expect(injectedText).toContain("<supporting_recall>");
      expect(injectedText).toContain("PostgreSQL");
      expect(injectedText).toContain("</supporting_recall>");
    });
  });

  // ── Disabled-flag fallback ──────────────────────────────────────

  describe("disabled-flag fallback", () => {
    test("falls back to legacy path when memory.simplified.enabled is false", async () => {
      // Disable the simplified flag
      testConfig = {
        ...DEFAULT_CONFIG,
        memory: {
          ...DEFAULT_CONFIG.memory,
          enabled: true,
          simplified: {
            ...DEFAULT_CONFIG.memory.simplified,
            enabled: false,
          },
        },
      };

      // The legacy retriever mock throws, so we need to unmock it for
      // this test. Instead, we verify the flag gating by checking the
      // code path via the mock that throws — if the simplified path is
      // correctly bypassed, the legacy path will be invoked.
      const ctx = buildCtx({
        messages: [makeUserMessage("Hello there")],
      });
      const msgId = uuid();

      // The legacy path calls buildMemoryRecall which we mocked to throw.
      // This confirms the code took the legacy path, not the simplified one.
      let hitLegacyPath = false;
      try {
        await prepareMemoryContext(
          ctx,
          "Hello there",
          msgId,
          abortController.signal,
          onEvent,
        );
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("should not be called in simplified mode")
        ) {
          hitLegacyPath = true;
        } else {
          throw err;
        }
      }

      expect(hitLegacyPath).toBe(true);
    });
  });

  // ── Gate checks ─────────────────────────────────────────────────

  describe("gate checks", () => {
    test("skips memory for untrusted actors in simplified mode", async () => {
      const now = Date.now();
      insertTimeContext({
        id: "tc-1",
        summary: "Meeting in 1 hour",
        activeFrom: now - HOUR,
        activeUntil: now + HOUR,
      });

      const ctx = buildCtx({
        trustClass: "unknown",
        messages: [makeUserMessage("What are my meetings?")],
      });
      const msgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "What are my meetings?",
        msgId,
        abortController.signal,
        onEvent,
      );

      // Should return unmodified messages (no memory injection)
      expect(result.runMessages).toEqual(ctx.messages);
      expect(result.recall.enabled).toBe(false);
    });

    test("skips memory for tool-result-only turns in simplified mode", async () => {
      const now = Date.now();
      insertTimeContext({
        id: "tc-1",
        summary: "Important deadline",
        activeFrom: now - HOUR,
        activeUntil: now + HOUR,
      });

      const toolResultMsg: Message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "tool output",
          },
        ],
      };
      const ctx = buildCtx({ messages: [toolResultMsg] });
      const msgId = uuid();

      const result = await prepareMemoryContext(
        ctx,
        "",
        msgId,
        abortController.signal,
        onEvent,
      );

      // Should return unmodified messages
      expect(result.runMessages).toEqual(ctx.messages);
    });
  });
});
