/**
 * Asserts `listConsolidationRuns` maps background-conversation rows tagged
 * with `source = MEMORY_V2_CONSOLIDATION_SOURCE` into the heartbeat-runs
 * response shape, derives `status` / `durationMs` from `lastMessageAt`, and
 * clamps the `limit` query param.
 *
 * Synthetic-field semantics covered here:
 *   - `id` and `conversationId` both equal the conversation row's id.
 *   - `scheduledFor` and `startedAt` both equal `conversation.createdAt`
 *     (no separate schedule timestamp on the row).
 *   - `finishedAt` equals `conversation.lastMessageAt`; `durationMs` is
 *     finishedAt − startedAt when both are present, else null.
 *   - `status` is `"ok"` when lastMessageAt is set (agent emitted at least
 *     one message) and `"running"` otherwise.
 *   - `skipReason` and `error` are always null — the conversation row alone
 *     cannot distinguish a clean run from a failed-mid-flight one.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createConversation } from "../../../memory/conversation-crud.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { rawRun } from "../../../memory/raw-query.js";
import { ROUTES } from "../consolidation-routes.js";
import type { RouteDefinition } from "../types.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

interface RunRecord {
  id: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: "ok" | "running";
  skipReason: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

interface ListRunsResponse {
  runs: RunRecord[];
}

describe("listConsolidationRuns handler", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns only conversations sourced from memory_v2_consolidation", async () => {
    createConversation({ title: "c1", source: "memory_v2_consolidation" });
    createConversation({ title: "h1", source: "heartbeat" });
    createConversation({ title: "u1", source: "user" });

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
  });

  test("synthesizes status='ok' with durationMs when lastMessageAt is set", async () => {
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "UPDATE conversations SET created_at = ?, last_message_at = ? WHERE id = ?",
      1000,
      2500,
      conv.id,
    );

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.id).toBe(conv.id);
    expect(run.conversationId).toBe(conv.id);
    expect(run.status).toBe("ok");
    expect(run.scheduledFor).toBe(1000);
    expect(run.startedAt).toBe(1000);
    expect(run.finishedAt).toBe(2500);
    expect(run.durationMs).toBe(1500);
    expect(run.createdAt).toBe(1000);
  });

  test("synthesizes status='running' with null finishedAt/durationMs when lastMessageAt is null", async () => {
    createConversation({ title: "c1", source: "memory_v2_consolidation" });

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect(run.durationMs).toBeNull();
  });

  test("skipReason and error are always null (not derivable from conversation row)", async () => {
    createConversation({ title: "c1", source: "memory_v2_consolidation" });

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs[0]!.skipReason).toBeNull();
    expect(result.runs[0]!.error).toBeNull();
  });

  test("orders runs by createdAt descending", async () => {
    const a = createConversation({
      title: "a",
      source: "memory_v2_consolidation",
    });
    const b = createConversation({
      title: "b",
      source: "memory_v2_consolidation",
    });
    const c = createConversation({
      title: "c",
      source: "memory_v2_consolidation",
    });
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 1000, a.id);
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 3000, b.id);
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 2000, c.id);

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
  });

  test("limit defaults to 20, clamps to [1, 100], and falls back on non-numeric input", async () => {
    for (let i = 0; i < 5; i++) {
      createConversation({
        title: `c${i}`,
        source: "memory_v2_consolidation",
      });
    }

    const handler = findHandler("listConsolidationRuns");

    // Default — all 5 returned (under the 20 default).
    const def = (await handler({})) as ListRunsResponse;
    expect(def.runs).toHaveLength(5);

    // Explicit limit honored.
    const lim2 = (await handler({
      queryParams: { limit: "2" },
    })) as ListRunsResponse;
    expect(lim2.runs).toHaveLength(2);

    // Negative clamps to 1.
    const neg = (await handler({
      queryParams: { limit: "-5" },
    })) as ListRunsResponse;
    expect(neg.runs).toHaveLength(1);

    // Zero clamps to 1.
    const zero = (await handler({
      queryParams: { limit: "0" },
    })) as ListRunsResponse;
    expect(zero.runs).toHaveLength(1);

    // Non-numeric falls back to the default (20 → all 5 here).
    const bad = (await handler({
      queryParams: { limit: "garbage" },
    })) as ListRunsResponse;
    expect(bad.runs).toHaveLength(5);
  });
});
