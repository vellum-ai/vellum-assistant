/**
 * Tests for `GET /v1/acp/sessions`.
 *
 * The handler merges in-memory `AcpSessionManager.getStatus()` output with
 * persisted `acp_session_history` rows, deduping by id (in-memory wins),
 * filtering by `?conversationId`, sorting newest-first, and truncating to
 * `?limit` (default 50, max 500).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Stub the ACP session manager so tests control the in-memory side without
// spawning real child processes. The route handler imports
// `getAcpSessionManager` from `../../../acp/index.js`; we replace that
// module's export with a getter that returns whatever the current test set.
// ---------------------------------------------------------------------------

interface FakeSessionState {
  id: string;
  agentId: string;
  acpSessionId: string;
  parentConversationId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: string;
}

let fakeInMemorySessions: FakeSessionState[] = [];

mock.module("../../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: () => fakeInMemorySessions,
  }),
  broadcastToAllClients: null,
}));

import { getSqlite, initializeDb } from "../../../memory/db.js";
import type { RouteContext } from "../../http-router.js";
import { acpRouteDefinitions } from "../acp-routes.js";

initializeDb();

function clearHistory(): void {
  getSqlite().run("DELETE FROM acp_session_history");
}

function insertHistoryRow(row: {
  id: string;
  agentId: string;
  acpSessionId: string;
  parentConversationId: string;
  startedAt: number;
  completedAt?: number | null;
  status: string;
  stopReason?: string | null;
  error?: string | null;
  eventLogJson?: string;
}): void {
  getSqlite()
    .query(
      /*sql*/ `
      INSERT INTO acp_session_history (
        id,
        agent_id,
        acp_session_id,
        parent_conversation_id,
        started_at,
        completed_at,
        status,
        stop_reason,
        error,
        event_log_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      row.id,
      row.agentId,
      row.acpSessionId,
      row.parentConversationId,
      row.startedAt,
      row.completedAt ?? null,
      row.status,
      row.stopReason ?? null,
      row.error ?? null,
      row.eventLogJson ?? "[]",
    );
}

function getSessionsHandler() {
  const routes = acpRouteDefinitions();
  const route = routes.find(
    (r) => r.endpoint === "acp/sessions" && r.method === "GET",
  );
  if (!route) throw new Error("acp/sessions GET route not found");
  return route.handler;
}

function makeCtx(query: Record<string, string> = {}): RouteContext {
  const url = new URL("http://localhost/v1/acp/sessions");
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return {
    req: new Request(url),
    url,
    server: {} as RouteContext["server"],
    authContext: {} as never,
    params: {},
  };
}

interface ResponseShape {
  sessions: Array<{
    id: string;
    agentId: string;
    acpSessionId: string;
    parentConversationId?: string;
    status: string;
    startedAt: number;
    completedAt?: number | null;
    stopReason?: string | null;
    error?: string | null;
    eventLog?: unknown[];
  }>;
}

beforeEach(() => {
  fakeInMemorySessions = [];
  clearHistory();
});

describe("GET /v1/acp/sessions — merged in-memory + history", () => {
  test("returns an empty array when no sessions exist", async () => {
    const handler = getSessionsHandler();
    const res = await handler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toEqual([]);
  });

  test("returns only in-memory sessions when history is empty", async () => {
    fakeInMemorySessions = [
      {
        id: "live-1",
        agentId: "agent-A",
        acpSessionId: "proto-1",
        parentConversationId: "conv-x",
        status: "running",
        startedAt: 1000,
      },
    ];

    const handler = getSessionsHandler();
    const res = await handler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "live-1",
      agentId: "agent-A",
      acpSessionId: "proto-1",
      parentConversationId: "conv-x",
      status: "running",
      startedAt: 1000,
    });
    // No eventLog on in-memory sessions.
    expect(body.sessions[0].eventLog).toBeUndefined();
  });

  test("returns only history rows when no in-memory sessions exist", async () => {
    insertHistoryRow({
      id: "hist-1",
      agentId: "agent-B",
      acpSessionId: "proto-h1",
      parentConversationId: "conv-y",
      startedAt: 2000,
      completedAt: 3000,
      status: "completed",
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([
        {
          type: "acp_session_update",
          acpSessionId: "hist-1",
          updateType: "agent_message_chunk",
          content: "hello",
        },
      ]),
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0];
    expect(s.id).toBe("hist-1");
    expect(s.parentConversationId).toBe("conv-y");
    expect(s.status).toBe("completed");
    expect(s.stopReason).toBe("end_turn");
    expect(s.completedAt).toBe(3000);
    // event log was deserialized from event_log_json.
    expect(s.eventLog).toEqual([
      {
        type: "acp_session_update",
        acpSessionId: "hist-1",
        updateType: "agent_message_chunk",
        content: "hello",
      },
    ]);
  });

  test("dedupes by id with in-memory winning on collision", async () => {
    // Same id in both layers — in-memory entry should win and eventLog
    // (which only history carries) must be absent on the merged record.
    fakeInMemorySessions = [
      {
        id: "shared-1",
        agentId: "agent-live",
        acpSessionId: "proto-live",
        parentConversationId: "conv-live",
        status: "running",
        startedAt: 5000,
      },
    ];
    insertHistoryRow({
      id: "shared-1",
      agentId: "agent-stale",
      acpSessionId: "proto-stale",
      parentConversationId: "conv-stale",
      startedAt: 1000,
      completedAt: 1500,
      status: "completed",
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([{ stale: true }]),
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx());
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].agentId).toBe("agent-live");
    expect(body.sessions[0].status).toBe("running");
    expect(body.sessions[0].startedAt).toBe(5000);
    expect(body.sessions[0].eventLog).toBeUndefined();
  });

  test("merges in-memory and disjoint history rows", async () => {
    fakeInMemorySessions = [
      {
        id: "live-1",
        agentId: "agent-A",
        acpSessionId: "proto-1",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 3000,
      },
    ];
    insertHistoryRow({
      id: "hist-1",
      agentId: "agent-B",
      acpSessionId: "proto-h1",
      parentConversationId: "conv-2",
      startedAt: 1000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx());
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(2);
    // Sorted newest-first by startedAt.
    expect(body.sessions[0].id).toBe("live-1");
    expect(body.sessions[1].id).toBe("hist-1");
  });

  test("?limit truncates the merged set after sorting", async () => {
    // Two in-memory + three history rows → 5 total. Limit to 2.
    fakeInMemorySessions = [
      {
        id: "live-newest",
        agentId: "agent-A",
        acpSessionId: "proto-A",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 5000,
      },
      {
        id: "live-mid",
        agentId: "agent-A",
        acpSessionId: "proto-A2",
        parentConversationId: "conv-1",
        status: "running",
        startedAt: 3000,
      },
    ];
    insertHistoryRow({
      id: "hist-old",
      agentId: "agent-B",
      acpSessionId: "proto-B",
      parentConversationId: "conv-2",
      startedAt: 1000,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-older",
      agentId: "agent-B",
      acpSessionId: "proto-B2",
      parentConversationId: "conv-2",
      startedAt: 500,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-mid",
      agentId: "agent-B",
      acpSessionId: "proto-B3",
      parentConversationId: "conv-2",
      startedAt: 4000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx({ limit: "2" }));
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s) => s.id)).toEqual(["live-newest", "hist-mid"]);
  });

  test("?conversationId filters both in-memory and history entries", async () => {
    fakeInMemorySessions = [
      {
        id: "live-match",
        agentId: "agent-A",
        acpSessionId: "p1",
        parentConversationId: "conv-target",
        status: "running",
        startedAt: 4000,
      },
      {
        id: "live-other",
        agentId: "agent-A",
        acpSessionId: "p2",
        parentConversationId: "conv-other",
        status: "running",
        startedAt: 3500,
      },
    ];
    insertHistoryRow({
      id: "hist-match",
      agentId: "agent-B",
      acpSessionId: "p3",
      parentConversationId: "conv-target",
      startedAt: 2000,
      status: "completed",
    });
    insertHistoryRow({
      id: "hist-other",
      agentId: "agent-B",
      acpSessionId: "p4",
      parentConversationId: "conv-other",
      startedAt: 1000,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx({ conversationId: "conv-target" }));
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions.map((s) => s.id)).toEqual([
      "live-match",
      "hist-match",
    ]);
  });

  test("?limit clamps to the maximum (500)", async () => {
    // Insert 3 rows; ensure a wildly-too-large limit doesn't error and the
    // response is bounded by row count rather than the requested value.
    insertHistoryRow({
      id: "h1",
      agentId: "a",
      acpSessionId: "p1",
      parentConversationId: "c",
      startedAt: 100,
      status: "completed",
    });
    insertHistoryRow({
      id: "h2",
      agentId: "a",
      acpSessionId: "p2",
      parentConversationId: "c",
      startedAt: 200,
      status: "completed",
    });
    insertHistoryRow({
      id: "h3",
      agentId: "a",
      acpSessionId: "p3",
      parentConversationId: "c",
      startedAt: 300,
      status: "completed",
    });

    const handler = getSessionsHandler();
    const res = await handler(makeCtx({ limit: "9999" }));
    const body = (await res.json()) as ResponseShape;
    expect(body.sessions).toHaveLength(3);
  });
});
