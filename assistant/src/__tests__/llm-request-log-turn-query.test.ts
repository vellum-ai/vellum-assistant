import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "llm-request-log-turn-query-test-")),
);
const workspaceDir = join(testDir, ".vellum", "workspace");
const conversationsDir = join(workspaceDir, "conversations");

mock.module("../util/platform.js", () => ({
  getRootDir: () => join(testDir, ".vellum"),
  getDataDir: () => join(workspaceDir, "data"),
  getWorkspaceDir: () => workspaceDir,
  getConversationsDir: () => conversationsDir,
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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  addMessage,
  createConversation,
  forkConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  backfillMessageIdOnLogs,
  getRequestLogsByMessageId,
  recordRequestLog,
} from "../memory/llm-request-log-store.js";
import { llmRequestLogs, toolInvocations } from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(llmRequestLogs).run();
  db.delete(toolInvocations).run();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function toolResultContent(toolUseIds: string[]): string {
  return JSON.stringify(
    toolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "ok",
      is_error: false,
    })),
  );
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("getRequestLogsByMessageId — turn-aware query", () => {
  beforeEach(() => {
    resetTables();
  });

  test("single message, single log: backward compat — returns 1 log", async () => {
    const conv = createConversation("single-msg");
    await addMessage(conv.id, "user", "Hello", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Hi!", undefined, {
      skipIndexing: true,
    });

    // Record a log without messageId, then backfill
    recordRequestLog(conv.id, '{"prompt":"hi"}', '{"result":"hello"}');
    backfillMessageIdOnLogs(conv.id, a1.id);

    const logs = getRequestLogsByMessageId(a1.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.messageId).toBe(a1.id);
    expect(logs[0]?.conversationId).toBe(conv.id);
  });

  test("multi-step turn: returns logs from all assistant messages in the turn", async () => {
    const conv = createConversation("multi-step");

    // user → A1 (+ log1) → tool_result → A2 (+ log2)
    await addMessage(conv.id, "user", "Do the task", undefined, {
      skipIndexing: true,
    });

    // First LLM call → A1
    recordRequestLog(conv.id, '{"step":1}', '{"tool_use":"bash"}');
    const a1 = await addMessage(
      conv.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(conv.id, a1.id);

    // tool_result user message
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );

    // Second LLM call → A2
    recordRequestLog(conv.id, '{"step":2}', '{"result":"done"}');
    const a2 = await addMessage(conv.id, "assistant", "All done!", undefined, {
      skipIndexing: true,
    });
    backfillMessageIdOnLogs(conv.id, a2.id);

    // Query from A2 (the last message in the turn) → should return both logs
    const logs = getRequestLogsByMessageId(a2.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.messageId).toBe(a1.id);
    expect(logs[1]?.messageId).toBe(a2.id);
    // Verify ordering is by createdAt ASC
    expect(logs[0]!.createdAt).toBeLessThanOrEqual(logs[1]!.createdAt);
  });

  test("fork fallback still works: forked message with no logs, source has turn logs", async () => {
    const source = createConversation("source-conv");

    // Build a multi-step turn in the source conversation
    await addMessage(source.id, "user", "Original task", undefined, {
      skipIndexing: true,
    });

    recordRequestLog(source.id, '{"step":1}', '{"tool":"bash"}');
    const a1 = await addMessage(
      source.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(source.id, a1.id);

    await addMessage(
      source.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );

    recordRequestLog(source.id, '{"step":2}', '{"result":"ok"}');
    const a2 = await addMessage(
      source.id,
      "assistant",
      "Done with source!",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(source.id, a2.id);

    // Fork the conversation
    const fork = forkConversation({ conversationId: source.id });
    const forkMessages = (
      await import("../memory/conversation-crud.js")
    ).getMessages(fork.id);
    const forkLastAssistant = forkMessages
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(forkLastAssistant).toBeDefined();

    // The fork has no LLM logs of its own — should fall back to source turn's logs
    const logs = getRequestLogsByMessageId(forkLastAssistant!.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.conversationId).toBe(source.id);
    expect(logs[1]?.conversationId).toBe(source.id);
  });

  test("logs from different turns don't bleed", async () => {
    const conv = createConversation("two-turns");

    // First turn: user → A1 (+ log1)
    await addMessage(conv.id, "user", "First question", undefined, {
      skipIndexing: true,
    });
    recordRequestLog(conv.id, '{"turn":1}', '{"answer":"first"}');
    const a1 = await addMessage(
      conv.id,
      "assistant",
      "First answer",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(conv.id, a1.id);

    // Second turn: user → A2 (+ log2) → tool_result → A3 (+ log3)
    await addMessage(conv.id, "user", "Second question", undefined, {
      skipIndexing: true,
    });
    recordRequestLog(conv.id, '{"turn":2,"step":1}', '{"tool":"bash"}');
    const a2 = await addMessage(
      conv.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(conv.id, a2.id);

    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-2"]),
      undefined,
      { skipIndexing: true },
    );

    recordRequestLog(conv.id, '{"turn":2,"step":2}', '{"result":"done"}');
    const a3 = await addMessage(
      conv.id,
      "assistant",
      "Second done!",
      undefined,
      { skipIndexing: true },
    );
    backfillMessageIdOnLogs(conv.id, a3.id);

    // Query second turn → should only return logs for A2 and A3, NOT A1
    const secondTurnLogs = getRequestLogsByMessageId(a3.id);
    expect(secondTurnLogs).toHaveLength(2);
    expect(secondTurnLogs[0]?.messageId).toBe(a2.id);
    expect(secondTurnLogs[1]?.messageId).toBe(a3.id);

    // Query first turn → should only return log for A1
    const firstTurnLogs = getRequestLogsByMessageId(a1.id);
    expect(firstTurnLogs).toHaveLength(1);
    expect(firstTurnLogs[0]?.messageId).toBe(a1.id);
  });
});
