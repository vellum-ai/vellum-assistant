/**
 * Tests for the GET /v1/acp/sessions list handler's `eventLog` population:
 * active in-memory sessions source it from the live ring buffer (each item
 * carrying `seq`), while terminal DB rows source it from persisted
 * `eventLogJson`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/index.js";
import type { AcpSessionUpdate } from "../../daemon/message-types/acp.js";

const inMemoryStates = new Map<string, AcpSessionState>();
const bufferedUpdates = new Map<string, AcpSessionUpdate[]>();

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: (id?: string) => {
      if (id === undefined) return Array.from(inMemoryStates.values());
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
    },
    getBufferedUpdates: (id: string) => bufferedUpdates.get(id) ?? [],
  }),
}));

// Terminal history rows go through the real DB (like the sibling acp-routes
// suite), not a `db-connection` module stub. A process-global `db-connection`
// mock would omit named exports (`getTelemetrySqlite`, …) and poison `getDb`
// for adjacent route tests that call `initializeDb()` in the same Bun
// invocation, so we seed real rows via the shared history helper instead.
import {
  clearHistory,
  insertHistoryRow,
} from "../../acp/__tests__/helpers/acp-history-db.js";
import { initializeDb } from "../../persistence/db-init.js";

const { ROUTES } = await import("./acp-routes.js");

await initializeDb();

function getListHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions" && r.method === "GET",
  );
  if (!route) throw new Error("GET acp/sessions route not registered");
  return route.handler;
}

function makeInMemoryState(
  id: string,
  parentConversationId: string,
  extra?: Pick<AcpSessionState, "task" | "parentToolUseId" | "latestUsage">,
): AcpSessionState {
  return {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId,
    status: "running",
    startedAt: 1_700_000_000_000,
    ...extra,
  };
}

function makeUpdate(seq: number, content: string): AcpSessionUpdate {
  return {
    type: "acp_session_update",
    acpSessionId: "active",
    updateType: "agent_message_chunk",
    content,
    seq,
  };
}

beforeEach(() => {
  inMemoryStates.clear();
  bufferedUpdates.clear();
  clearHistory();
});

afterAll(() => {
  inMemoryStates.clear();
  bufferedUpdates.clear();
  clearHistory();
});

describe("GET /v1/acp/sessions — eventLog", () => {
  test("active in-memory session returns eventLog from the live ring buffer with seq", async () => {
    inMemoryStates.set("active", makeInMemoryState("active", "conv-1"));
    bufferedUpdates.set("active", [
      makeUpdate(1, "hello"),
      makeUpdate(2, "world"),
    ]);

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    const eventLog = session?.eventLog as AcpSessionUpdate[];
    expect(eventLog).toHaveLength(2);
    expect(eventLog.map((u) => u.seq)).toEqual([1, 2]);
    expect(eventLog[0]?.content).toBe("hello");
  });

  test("active in-memory session carries task and parentToolUseId from the SessionEntry", async () => {
    inMemoryStates.set(
      "active",
      makeInMemoryState("active", "conv-1", {
        task: "Refactor the auth module",
        parentToolUseId: "tool-use-abc",
      }),
    );

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    expect(session?.task).toBe("Refactor the auth module");
    expect(session?.parentToolUseId).toBe("tool-use-abc");
  });

  test("terminal DB row returns its persisted eventLog", async () => {
    insertHistoryRow({
      id: "terminal",
      agentId: "claude",
      acpSessionId: "proto-terminal",
      parentConversationId: "conv-1",
      status: "completed",
      startedAt: 1_699_000_000_000,
      completedAt: 1_699_000_001_000,
      error: null,
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([makeUpdate(7, "persisted")]),
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal");
    expect(session).toBeDefined();
    const eventLog = session?.eventLog as AcpSessionUpdate[];
    expect(eventLog).toHaveLength(1);
    expect(eventLog[0]?.seq).toBe(7);
    expect(eventLog[0]?.content).toBe("persisted");
  });

  test("active and terminal sessions both surface tool_call rawInput/rawOutput in eventLog", async () => {
    const rawInput = { command: "grep -rn foo", pattern: "foo" };
    const rawOutput = "src/a.ts:1: foo\nsrc/b.ts:9: foo";

    const activeToolCall: AcpSessionUpdate = {
      type: "acp_session_update",
      acpSessionId: "active",
      updateType: "tool_call",
      toolCallId: "tc-active",
      toolKind: "search",
      toolStatus: "completed",
      rawInput,
      rawOutput,
      seq: 1,
    };
    inMemoryStates.set("active", makeInMemoryState("active", "conv-1"));
    bufferedUpdates.set("active", [activeToolCall]);

    insertHistoryRow({
      id: "terminal",
      parentConversationId: "conv-1",
      eventLogJson: JSON.stringify([
        {
          type: "acp_session_update",
          acpSessionId: "terminal",
          updateType: "tool_call",
          toolCallId: "tc-terminal",
          toolKind: "search",
          toolStatus: "completed",
          rawInput,
          rawOutput,
          seq: 1,
        } satisfies AcpSessionUpdate,
      ]),
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    for (const id of ["active", "terminal"]) {
      const session = result.sessions.find((s) => s.id === id);
      expect(session).toBeDefined();
      const eventLog = session?.eventLog as AcpSessionUpdate[];
      expect(eventLog).toHaveLength(1);
      expect(eventLog[0]?.rawInput).toEqual(rawInput);
      expect(eventLog[0]?.rawOutput).toBe(rawOutput);
    }
  });

  test("active in-memory session surfaces latestUsage as the usage fields", async () => {
    inMemoryStates.set(
      "active",
      makeInMemoryState("active", "conv-1", {
        latestUsage: {
          usedTokens: 1234,
          contextSize: 200_000,
          costAmount: 0.5,
          costCurrency: "USD",
        },
      }),
    );

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    expect(session?.usedTokens).toBe(1234);
    expect(session?.contextSize).toBe(200_000);
    expect(session?.costAmount).toBe(0.5);
    expect(session?.costCurrency).toBe("USD");
  });

  test("terminal DB row returns persisted task, parentToolUseId, and usage", async () => {
    insertHistoryRow({
      id: "terminal-usage",
      parentConversationId: "conv-1",
      task: "Refactor the parser",
      parentToolUseId: "tool-use-xyz",
      usedTokens: 8000,
      contextSize: 200_000,
      costAmount: 0.0456,
      costCurrency: "USD",
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal-usage");
    expect(session).toBeDefined();
    expect(session?.task).toBe("Refactor the parser");
    expect(session?.parentToolUseId).toBe("tool-use-xyz");
    expect(session?.usedTokens).toBe(8000);
    expect(session?.contextSize).toBe(200_000);
    expect(session?.costAmount).toBe(0.0456);
    expect(session?.costCurrency).toBe("USD");
  });

  test("pre-migration terminal row (NULL usage columns) degrades to undefined", async () => {
    insertHistoryRow({
      id: "terminal-legacy",
      parentConversationId: "conv-1",
      // task/parentToolUseId/usage columns default to NULL.
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal-legacy");
    expect(session).toBeDefined();
    expect(session?.task).toBeUndefined();
    expect(session?.parentToolUseId).toBeUndefined();
    expect(session?.usedTokens).toBeUndefined();
    expect(session?.contextSize).toBeUndefined();
    expect(session?.costAmount).toBeUndefined();
    expect(session?.costCurrency).toBeUndefined();
  });
});
