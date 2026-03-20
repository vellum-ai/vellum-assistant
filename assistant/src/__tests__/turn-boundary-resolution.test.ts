import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "turn-boundary-resolution-test-")),
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
  getAssistantMessageIdsInTurn,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
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

describe("getAssistantMessageIdsInTurn", () => {
  beforeEach(() => {
    resetTables();
  });

  test("single-step turn: returns only the one assistant message", async () => {
    const conv = createConversation("single-step");
    await addMessage(conv.id, "user", "Hello", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Hi there!", undefined, {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a1.id);
    expect(result).toEqual([a1.id]);
  });

  test("multi-step turn: user → A1 → tool_result → A2 → query A2 → returns [A1, A2]", async () => {
    const conv = createConversation("multi-step");
    await addMessage(conv.id, "user", "Do the thing", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(
      conv.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );
    const a2 = await addMessage(conv.id, "assistant", "Done!", undefined, {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a2.id);
    expect(result).toEqual([a1.id, a2.id]);
  });

  test("3-step turn: user → A1 → tool_result → A2 → tool_result → A3 → query A3 → returns [A1, A2, A3]", async () => {
    const conv = createConversation("three-step");
    await addMessage(conv.id, "user", "Complex task", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Step 1...", undefined, {
      skipIndexing: true,
    });
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );
    const a2 = await addMessage(conv.id, "assistant", "Step 2...", undefined, {
      skipIndexing: true,
    });
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-2"]),
      undefined,
      { skipIndexing: true },
    );
    const a3 = await addMessage(conv.id, "assistant", "All done!", undefined, {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a1.id, a2.id, a3.id]);
  });

  test("query intermediate message: query A1 in a 2-step turn → returns [A1, A2]", async () => {
    const conv = createConversation("intermediate");
    await addMessage(conv.id, "user", "Start task", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(
      conv.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );
    const a2 = await addMessage(conv.id, "assistant", "Done!", undefined, {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a1.id);
    expect(result).toEqual([a1.id, a2.id]);
  });

  test("message not found: returns [messageId]", () => {
    const result = getAssistantMessageIdsInTurn("nonexistent-id");
    expect(result).toEqual(["nonexistent-id"]);
  });

  test("consecutive turns: query message in second turn → returns only that turn's messages", async () => {
    const conv = createConversation("consecutive");

    // First turn
    await addMessage(conv.id, "user", "First question", undefined, {
      skipIndexing: true,
    });
    const a1 = await addMessage(
      conv.id,
      "assistant",
      "First answer",
      undefined,
      { skipIndexing: true },
    );

    // Second turn
    await addMessage(conv.id, "user", "Second question", undefined, {
      skipIndexing: true,
    });
    const a2 = await addMessage(
      conv.id,
      "assistant",
      "Using tool...",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(
      conv.id,
      "user",
      toolResultContent(["tool-1"]),
      undefined,
      { skipIndexing: true },
    );
    const a3 = await addMessage(
      conv.id,
      "assistant",
      "Done with second",
      undefined,
      { skipIndexing: true },
    );

    // Query second turn → should NOT include a1
    const result = getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a2.id, a3.id]);

    // Query first turn → should only include a1
    const firstTurnResult = getAssistantMessageIdsInTurn(a1.id);
    expect(firstTurnResult).toEqual([a1.id]);
  });
});
