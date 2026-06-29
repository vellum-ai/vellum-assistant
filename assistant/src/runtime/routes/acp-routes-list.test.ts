/**
 * Tests for the GET /v1/acp/sessions list handler — specifically the SQL
 * pad amount applied to acp_session_history when in-memory sessions are
 * also present. We mock the DB layer so the limit value passed to the
 * query builder can be asserted directly.
 *
 * Regression for codex P2 feedback on PR #29993: padding by the global
 * inMemory.length over-fetched when many unrelated sessions were live
 * but only one conversation was being queried.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/index.js";

const inMemoryStates = new Map<string, AcpSessionState>();

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: (id?: string) => {
      if (id === undefined) return Array.from(inMemoryStates.values());
      const state = inMemoryStates.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
    },
    getBufferedUpdates: () => [],
  }),
}));

// Assert the exact SQL limit the handler passes by spying on the real
// drizzle builder's `limit()` — we run the real DB (like the sibling
// acp-routes suite) rather than stubbing `db-connection`. A process-global
// module stub would omit named exports and poison `getDb` for adjacent route
// tests that call `initializeDb()` in the same Bun invocation.
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { acpSessionHistory } from "../../persistence/schema/index.js";

await initializeDb();

const capturedLimits: number[] = [];

// `.limit()` lives on the SQLiteSelect prototype and mutates/returns `this`.
// Patch it once on the prototype so the spy survives across query chains, and
// restore in `afterAll` so other suites see the unpatched builder.
const selectProto = Object.getPrototypeOf(
  getDb().select().from(acpSessionHistory),
);
const originalLimit = selectProto.limit;
selectProto.limit = function patchedLimit(this: unknown, n: number) {
  capturedLimits.push(n);
  return originalLimit.call(this, n);
};

const { ROUTES } = await import("./acp-routes.js");

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

afterAll(() => {
  inMemoryStates.clear();
  capturedLimits.length = 0;
  selectProto.limit = originalLimit;
});

describe("GET /v1/acp/sessions — SQL pad amount", () => {
  test("pads SQL limit by the conversation-filtered in-memory count, not the global one", async () => {
    inMemoryStates.clear();
    capturedLimits.length = 0;

    // Many in-memory sessions for an unrelated conversation, plus one
    // that matches the target conversation.
    for (let i = 0; i < 25; i++) {
      inMemoryStates.set(
        `other-${i}`,
        makeInMemoryState(`other-${i}`, "conv-other"),
      );
    }
    inMemoryStates.set(
      "target-mem",
      makeInMemoryState("target-mem", "conv-target"),
    );

    const handler = getListHandler();
    await handler({
      queryParams: { conversationId: "conv-target", limit: "10" },
    });

    expect(capturedLimits).toHaveLength(1);
    // pad = filtered in-memory count (1), not global (26).
    expect(capturedLimits[0]).toBe(11);
  });

  test("pads by zero when no in-memory sessions match the target conversation", async () => {
    inMemoryStates.clear();
    capturedLimits.length = 0;

    for (let i = 0; i < 10; i++) {
      inMemoryStates.set(
        `other-${i}`,
        makeInMemoryState(`other-${i}`, "conv-other"),
      );
    }

    const handler = getListHandler();
    await handler({
      queryParams: { conversationId: "conv-target", limit: "5" },
    });

    expect(capturedLimits).toEqual([5]);
  });

  test("pads by the full in-memory count when no conversation filter is supplied", async () => {
    inMemoryStates.clear();
    capturedLimits.length = 0;

    for (let i = 0; i < 4; i++) {
      inMemoryStates.set(
        `sess-${i}`,
        makeInMemoryState(`sess-${i}`, `conv-${i}`),
      );
    }

    const handler = getListHandler();
    await handler({ queryParams: { limit: "20" } });

    expect(capturedLimits).toEqual([24]);
  });
});
