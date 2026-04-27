/**
 * Tests for the ACP route handlers.
 *
 * Suites:
 *  - POST /v1/acp/spawn — the three failure paths produced by
 *    `resolveAcpAgent` (acp_disabled, unknown_agent, binary_not_found).
 *  - DELETE /v1/acp/sessions?status=completed — the bulk-clear route that
 *    wipes terminal-state rows (completed/failed/cancelled) from
 *    `acp_session_history` while leaving running/initializing rows intact.
 *  - DELETE /v1/acp/sessions/:id — single-row delete: completed → 200,
 *    running → 409, unknown id → idempotent { deleted: false }.
 *
 * The spawn tests mirror the resolver's test setup using the shared
 * `installAcpConfigStub` and `installWhichStub` helpers so the host
 * environment doesn't influence the resolver's PATH preflight.
 *
 * The single-id delete tests stub `getAcpSessionManager` so we can drive
 * the in-memory-status check without spawning real ACP child processes,
 * and use the real DB (initialized via the test preload's per-file
 * workspace) to verify the row is actually removed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";
import type { AcpSessionState } from "../../acp/index.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

// Stub `getAcpSessionManager` so the DELETE /:id tests can drive the
// in-memory-status check without spawning real ACP processes. Stored in
// a mutable map so individual tests can plant arbitrary states.
const inMemoryStates = new Map<string, AcpSessionState>();

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: (id?: string) => {
      if (id === undefined) {
        return Array.from(inMemoryStates.values());
      }
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
    },
  }),
  // Spawn and bulk-DELETE tests don't reach this code path, but the mock
  // factory must export every name the SUT imports.
  broadcastToAllClients: null,
}));

import { eq } from "drizzle-orm";

import { getDb, getSqlite, initializeDb } from "../../memory/db.js";
import { acpSessionHistory } from "../../memory/schema.js";

const { ROUTES } = await import("./acp-routes.js");

function getSpawnHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/spawn" && r.method === "POST",
  );
  if (!route) throw new Error("acp/spawn route not registered");
  return route.handler;
}

beforeEach(() => {
  config.setConfig({});
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — failure paths from resolveAcpAgent
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn", () => {
  test("throws BadRequestError when ACP is disabled", async () => {
    config.setConfig({ enabled: false });

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "claude",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow("acp.enabled");
  });

  test("throws BadRequestError with merged available list when agent id is unknown", async () => {
    config.setConfig({
      agents: {
        "user-only": { command: "some-binary", args: [] },
      },
    });

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "nonexistent",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow('Unknown agent "nonexistent"');
  });

  test("throws FailedDependencyError when the agent binary is missing", async () => {
    config.setConfig({ agents: {} });
    which.setWhich({});

    const handler = getSpawnHandler();
    await expect(
      handler({
        body: {
          agent: "codex",
          task: "do a thing",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow("codex-acp is not on PATH");
  });

  test("body-shape guard short-circuits before the resolver runs", async () => {
    config.setConfig({ enabled: false });

    const handler = getSpawnHandler();
    await expect(handler({ body: { agent: "claude" } })).rejects.toThrow(
      "agent, task, and conversationId are required",
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/acp/sessions?status=completed — bulk-clear terminal rows
// ---------------------------------------------------------------------------

function getBulkDeleteHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions" && r.method === "DELETE",
  );
  if (!route) throw new Error("DELETE acp/sessions route not registered");
  return route.handler;
}

function seedHistoryRow(id: string, status: string, startedAt: number): void {
  getDb()
    .insert(acpSessionHistory)
    .values({
      id,
      agentId: "agent-x",
      acpSessionId: `proto-${id}`,
      parentConversationId: "conv-test",
      startedAt,
      completedAt: status === "running" ? null : startedAt + 1000,
      status,
      stopReason: status === "completed" ? "end_turn" : null,
      error: status === "failed" ? "boom" : null,
      eventLogJson: "[]",
    })
    .run();
}

interface RowSnapshot {
  id: string;
  status: string;
}

function listRows(): RowSnapshot[] {
  return getSqlite()
    .query("SELECT id, status FROM acp_session_history ORDER BY id")
    .all() as RowSnapshot[];
}

describe("DELETE /v1/acp/sessions?status=completed", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    getSqlite().run("DELETE FROM acp_session_history");
  });

  test("removes only terminal-state rows; running/initializing rows survive", async () => {
    seedHistoryRow("row-completed", "completed", 1000);
    seedHistoryRow("row-failed", "failed", 2000);
    seedHistoryRow("row-cancelled", "cancelled", 3000);
    seedHistoryRow("row-running", "running", 4000);
    seedHistoryRow("row-initializing", "initializing", 5000);

    const handler = getBulkDeleteHandler();
    const result = (await handler({ params: { status: "completed" } })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(3);

    const remaining = listRows();
    expect(remaining.map((r) => r.status).sort()).toEqual([
      "initializing",
      "running",
    ]);
  });

  test("returns deleted=0 when no terminal rows are present", async () => {
    seedHistoryRow("row-running", "running", 1000);

    const handler = getBulkDeleteHandler();
    const result = (await handler({ params: { status: "completed" } })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(0);

    const remaining = listRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("row-running");
  });

  test("rejects missing status query param with 400", async () => {
    seedHistoryRow("row-completed", "completed", 1000);

    const handler = getBulkDeleteHandler();
    expect(() => handler({})).toThrow("status");
    // Row must still be present — guard short-circuited before the delete.
    expect(listRows()).toHaveLength(1);
  });

  test("rejects status values other than 'completed' with 400", async () => {
    seedHistoryRow("row-completed", "completed", 1000);

    const handler = getBulkDeleteHandler();
    expect(() => handler({ params: { status: "failed" } })).toThrow("status");
    expect(listRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/acp/sessions/:id
// ---------------------------------------------------------------------------

function getDeleteSessionHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions/:id" && r.method === "DELETE",
  );
  if (!route) throw new Error("acp/sessions/:id DELETE route not registered");
  return route.handler;
}

function insertHistoryRow(opts: {
  id: string;
  status: AcpSessionState["status"];
}) {
  getDb()
    .insert(acpSessionHistory)
    .values({
      id: opts.id,
      agentId: "claude",
      acpSessionId: `proto-${opts.id}`,
      parentConversationId: "conv-1",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      status: opts.status,
      stopReason: null,
      error: null,
      eventLogJson: "[]",
    })
    .run();
}

describe("DELETE /v1/acp/sessions/:id", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    inMemoryStates.clear();
    getDb().delete(acpSessionHistory).run();
  });

  test("removes a completed session row and returns { deleted: true }", async () => {
    insertHistoryRow({ id: "sess-completed", status: "completed" });

    const handler = getDeleteSessionHandler();
    const result = (await handler({ params: { id: "sess-completed" } })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);

    // Row really gone.
    const remaining = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, "sess-completed"))
      .all();
    expect(remaining).toHaveLength(0);
  });

  test.each([["running" as const], ["initializing" as const]])(
    "returns 409 when the session is still %s in memory",
    async (status) => {
      inMemoryStates.set("sess-active", {
        id: "sess-active",
        agentId: "claude",
        acpSessionId: "proto-active",
        parentConversationId: "conv-1",
        status,
        startedAt: 1_700_000_000_000,
      });
      insertHistoryRow({ id: "sess-active", status: "completed" });

      const handler = getDeleteSessionHandler();
      expect(() => handler({ params: { id: "sess-active" } })).toThrow(
        `still ${status}`,
      );

      // Row untouched.
      const remaining = getDb()
        .select()
        .from(acpSessionHistory)
        .where(eq(acpSessionHistory.id, "sess-active"))
        .all();
      expect(remaining).toHaveLength(1);
    },
  );

  test("idempotent for unknown id — returns { deleted: false }", async () => {
    const handler = getDeleteSessionHandler();
    const result = (await handler({
      params: { id: "does-not-exist" },
    })) as { deleted: boolean };
    expect(result.deleted).toBe(false);
  });

  test("deletes a cancelled in-memory session whose row is in history", async () => {
    inMemoryStates.set("sess-cancelled", {
      id: "sess-cancelled",
      agentId: "claude",
      acpSessionId: "proto-cancelled",
      parentConversationId: "conv-1",
      status: "cancelled",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
    });
    insertHistoryRow({ id: "sess-cancelled", status: "cancelled" });

    const handler = getDeleteSessionHandler();
    const result = (await handler({
      params: { id: "sess-cancelled" },
    })) as { deleted: boolean };
    expect(result.deleted).toBe(true);
  });
});
