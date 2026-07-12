import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  getAssistantMessageIdsInTurn,
} from "../persistence/conversation-crud.js";
import { getDb, getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  llmRequestLogs,
  toolInvocations,
} from "../persistence/schema/index.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  getLogsDb()!.delete(llmRequestLogs).run();
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

describe("getAssistantMessageIdsInTurn", () => {
  beforeEach(() => {
    resetTables();
  });

  test("single-step turn: returns only the one assistant message", async () => {
    const conv = createConversation("single-step");
    await addMessage(conv.id, "user", "Hello", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Hi there!", {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a1.id);
    expect(result).toEqual([a1.id]);
  });

  test("multi-step turn: user → A1 → tool_result → A2 → query A2 → returns [A1, A2]", async () => {
    const conv = createConversation("multi-step");
    await addMessage(conv.id, "user", "Do the thing", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Done!", {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a2.id);
    expect(result).toEqual([a1.id, a2.id]);
  });

  test("3-step turn: user → A1 → tool_result → A2 → tool_result → A3 → query A3 → returns [A1, A2, A3]", async () => {
    const conv = createConversation("three-step");
    await addMessage(conv.id, "user", "Complex task", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Step 1...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Step 2...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-2"]), {
      skipIndexing: true,
    });
    const a3 = await addMessage(conv.id, "assistant", "All done!", {
      skipIndexing: true,
    });

    const result = getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a1.id, a2.id, a3.id]);
  });

  test("query intermediate message: query A1 in a 2-step turn → returns [A1, A2]", async () => {
    const conv = createConversation("intermediate");
    await addMessage(conv.id, "user", "Start task", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Done!", {
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
    await addMessage(conv.id, "user", "First question", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "First answer", {
      skipIndexing: true,
    });

    // Second turn
    await addMessage(conv.id, "user", "Second question", {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a3 = await addMessage(conv.id, "assistant", "Done with second", {
      skipIndexing: true,
    });

    // Query second turn → should NOT include a1
    const result = getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a2.id, a3.id]);

    // Query first turn → should only include a1
    const firstTurnResult = getAssistantMessageIdsInTurn(a1.id);
    expect(firstTurnResult).toEqual([a1.id]);
  });
});
