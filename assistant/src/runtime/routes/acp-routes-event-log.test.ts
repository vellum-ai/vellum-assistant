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
import { initializeDb } from "../../memory/db-init.js";

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
): AcpSessionState {
  return {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId,
    status: "running",
    startedAt: 1_700_000_000_000,
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
});
