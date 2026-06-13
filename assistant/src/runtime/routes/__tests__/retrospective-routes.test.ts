/**
 * Asserts `listRetrospectiveRuns` merges background-conversation rows from
 * BOTH retrospective sources (`memory-retrospective` → kind `legacy`,
 * `memory-retrospective-fork` → kind `fork`) into the heartbeat-runs
 * response shape (plus `kind` and `title`), derives `status` / `finishedAt`
 * from assistant-message presence **at or after the conversation's
 * createdAt** (fork runs copy source messages with their original
 * timestamps), and clamps the `limit` query param.
 *
 * Also asserts `getRetrospectiveConfig` gates `available` on
 * `memory.enabled` alone (NOT `memory.v2.enabled`) and always reports
 * `nextRunAt: null` — retrospectives are event-driven per conversation,
 * never globally scheduled.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { invalidateConfigCache } from "../../../config/loader.js";
import { createConversation } from "../../../memory/conversation-crud.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { recordUsageEvent } from "../../../memory/llm-usage-store.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "../../../memory/memory-retrospective-constants.js";
import { rawRun } from "../../../memory/raw-query.js";
import { ROUTES } from "../retrospective-routes.js";
import type { RouteDefinition } from "../types.js";

initializeDb();

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let configPath: string;

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM llm_usage_events`);
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function insertMessage(
  conversationId: string,
  role: string,
  createdAt: number,
): void {
  rawRun(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    `msg-${conversationId}-${role}-${createdAt}`,
    conversationId,
    role,
    "x",
    createdAt,
  );
}

function setCreatedAt(conversationId: string, createdAt: number): void {
  rawRun(
    "UPDATE conversations SET created_at = ? WHERE id = ?",
    createdAt,
    conversationId,
  );
}

function recordUsageCostAt(
  conversationId: string,
  requestId: string,
  createdAt: number,
  estimatedCostUsd: number,
): void {
  const event = recordUsageEvent(
    {
      conversationId,
      runId: null,
      requestId,
      actor: "main_agent",
      callSite: "mainAgent",
      inferenceProfile: "balanced",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      rawUsage: null,
    },
    { estimatedCostUsd, pricingStatus: "priced" },
  );
  rawRun(
    "UPDATE llm_usage_events SET created_at = ? WHERE id = ?",
    createdAt,
    event.id,
  );
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
  estimatedCostUsd: number;
  createdAt: number;
  kind: "legacy" | "fork";
  title: string | null;
}

interface ListRunsResponse {
  runs: RunRecord[];
}

interface ConfigResponse {
  available: boolean;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  success: boolean;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-retrospective-routes-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  configPath = join(workspaceDir, "config.json");
  invalidateConfigCache();
  resetTables();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  invalidateConfigCache();
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("listRetrospectiveRuns handler", () => {
  test("merges both retrospective sources with the kind field and excludes others", async () => {
    const legacy = createConversation({
      title: "legacy run",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    const fork = createConversation({
      title: "Planning chat (Retrospective)",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    createConversation({ title: "h1", source: "heartbeat" });
    createConversation({ title: "c1", source: "memory_v2_consolidation" });
    createConversation({ title: "u1", source: "user" });
    setCreatedAt(legacy.id, 1000);
    setCreatedAt(fork.id, 2000);

    const handler = findHandler("listRetrospectiveRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((r) => [r.id, r.kind, r.title])).toEqual([
      [fork.id, "fork", "Planning chat (Retrospective)"],
      [legacy.id, "legacy", "legacy run"],
    ]);
  });

  test("orders merged runs by createdAt descending across sources", async () => {
    const a = createConversation({
      title: "a",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    const b = createConversation({
      title: "b",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    const c = createConversation({
      title: "c",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    setCreatedAt(a.id, 1000);
    setCreatedAt(b.id, 3000);
    setCreatedAt(c.id, 2000);

    const handler = findHandler("listRetrospectiveRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
  });

  test("synthesizes status='ok' with finishedAt from latest assistant message", async () => {
    const conv = createConversation({
      title: "r1",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    setCreatedAt(conv.id, 1000);
    insertMessage(conv.id, "user", 1100);
    insertMessage(conv.id, "assistant", 2000);
    insertMessage(conv.id, "assistant", 2500);

    const handler = findHandler("listRetrospectiveRuns");
    const result = (await handler({})) as ListRunsResponse;

    const run = result.runs[0]!;
    expect(run.id).toBe(conv.id);
    expect(run.conversationId).toBe(conv.id);
    expect(run.status).toBe("ok");
    expect(run.scheduledFor).toBe(1000);
    expect(run.startedAt).toBe(1000);
    expect(run.finishedAt).toBe(2500);
    expect(run.durationMs).toBe(1500);
    expect(run.skipReason).toBeNull();
    expect(run.error).toBeNull();
  });

  test("fork run with only the copied source prefix stays 'running' (no negative duration)", async () => {
    // forkConversation copies source messages with their ORIGINAL
    // timestamps, so a fresh fork contains assistant messages that predate
    // the fork conversation's createdAt. Those must not count as agent
    // output — status stays 'running' until the retrospective agent itself
    // replies (at-or-after the fork's creation).
    const conv = createConversation({
      title: "Planning chat (Retrospective)",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    setCreatedAt(conv.id, 5000);
    // Copied prefix from the source conversation (pre-fork timestamps).
    insertMessage(conv.id, "user", 2000);
    insertMessage(conv.id, "assistant", 3000);

    const handler = findHandler("listRetrospectiveRuns");
    const running = (await handler({})) as ListRunsResponse;
    expect(running.runs[0]!.status).toBe("running");
    expect(running.runs[0]!.finishedAt).toBeNull();
    expect(running.runs[0]!.durationMs).toBeNull();

    // Retrospective agent replies after the fork was created.
    insertMessage(conv.id, "assistant", 6000);
    const done = (await handler({})) as ListRunsResponse;
    expect(done.runs[0]!.status).toBe("ok");
    expect(done.runs[0]!.finishedAt).toBe(6000);
    expect(done.runs[0]!.durationMs).toBe(1000);
  });

  test("exposes estimatedCostUsd from the conversation total, falling back to window usage", async () => {
    const withTotal = createConversation({
      title: "r1",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    rawRun(
      "UPDATE conversations SET created_at = ?, total_estimated_cost = ? WHERE id = ?",
      1000,
      0.42,
      withTotal.id,
    );
    insertMessage(withTotal.id, "assistant", 2000);

    const withWindow = createConversation({
      title: "r2",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    setCreatedAt(withWindow.id, 1000);
    insertMessage(withWindow.id, "assistant", 2000);
    recordUsageCostAt(withWindow.id, "retro-before", 999, 0.4);
    recordUsageCostAt(withWindow.id, "retro-inside", 1500, 0.07);
    recordUsageCostAt(withWindow.id, "retro-after", 2001, 0.5);

    const handler = findHandler("listRetrospectiveRuns");
    const result = (await handler({})) as ListRunsResponse;

    const byId = new Map(result.runs.map((r) => [r.id, r]));
    expect(byId.get(withTotal.id)!.estimatedCostUsd).toBeCloseTo(0.42);
    expect(byId.get(withWindow.id)!.estimatedCostUsd).toBeCloseTo(0.07);
  });

  test("limit defaults to 20, clamps to [1, 100], and merges correctly under the cap", async () => {
    // 3 legacy (newest) + 3 fork (older) — a merged limit of 4 must take
    // all 3 legacy rows plus the newest fork row, which requires fetching
    // the limit from EACH source before merging.
    const ids: Array<{ id: string; createdAt: number }> = [];
    for (let i = 0; i < 3; i++) {
      const conv = createConversation({
        title: `legacy-${i}`,
        source: MEMORY_RETROSPECTIVE_SOURCE,
      });
      setCreatedAt(conv.id, 10_000 + i);
      ids.push({ id: conv.id, createdAt: 10_000 + i });
    }
    for (let i = 0; i < 3; i++) {
      const conv = createConversation({
        title: `fork-${i}`,
        source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
      });
      setCreatedAt(conv.id, 5_000 + i);
      ids.push({ id: conv.id, createdAt: 5_000 + i });
    }
    const expectedTop4 = ids
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 4)
      .map((entry) => entry.id);

    const handler = findHandler("listRetrospectiveRuns");

    const def = (await handler({})) as ListRunsResponse;
    expect(def.runs).toHaveLength(6);

    const lim4 = (await handler({
      queryParams: { limit: "4" },
    })) as ListRunsResponse;
    expect(lim4.runs.map((r) => r.id)).toEqual(expectedTop4);

    const neg = (await handler({
      queryParams: { limit: "-5" },
    })) as ListRunsResponse;
    expect(neg.runs).toHaveLength(1);

    const huge = (await handler({
      queryParams: { limit: "5000" },
    })) as ListRunsResponse;
    expect(huge.runs).toHaveLength(6);

    const bad = (await handler({
      queryParams: { limit: "garbage" },
    })) as ListRunsResponse;
    expect(bad.runs).toHaveLength(6);
  });
});

describe("getRetrospectiveConfig handler", () => {
  test("reports availability and threshold interval with nextRunAt always null", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          memory: {
            retrospective: { timeThresholdMs: 45 * 60 * 1000 },
          },
        },
        null,
        2,
      ) + "\n",
    );
    const conv = createConversation({
      title: "r1",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    setCreatedAt(conv.id, 123_456);

    const handler = findHandler("getRetrospectiveConfig");
    const result = (await handler({})) as ConfigResponse;

    expect(result).toEqual({
      available: true,
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      nextRunAt: null,
      lastRunAt: 123_456,
      success: true,
    });
  });

  test("lastRunAt is the newest run across both sources, null when none exist", async () => {
    const handler = findHandler("getRetrospectiveConfig");
    const empty = (await handler({})) as ConfigResponse;
    expect(empty.lastRunAt).toBeNull();

    const legacy = createConversation({
      title: "legacy",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    const fork = createConversation({
      title: "fork",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    setCreatedAt(legacy.id, 9000);
    setCreatedAt(fork.id, 4000);

    const result = (await handler({})) as ConfigResponse;
    expect(result.lastRunAt).toBe(9000);
  });

  test("reports unavailable when global memory is disabled", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ memory: { enabled: false } }, null, 2) + "\n",
    );

    const handler = findHandler("getRetrospectiveConfig");
    const result = (await handler({})) as ConfigResponse;

    expect(result.available).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.nextRunAt).toBeNull();
    expect(result.success).toBe(true);
  });

  test("stays available when memory v2 is disabled (retrospectives do not gate on v2)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ memory: { v2: { enabled: false } } }, null, 2) + "\n",
    );

    const handler = findHandler("getRetrospectiveConfig");
    const result = (await handler({})) as ConfigResponse;

    expect(result.available).toBe(true);
    expect(result.enabled).toBe(true);
  });

  test("no run-now route is exposed (retrospectives are event-driven)", () => {
    expect(ROUTES.some((route) => route.method === "POST")).toBe(false);
    expect(
      ROUTES.find((route) => route.endpoint.includes("run-now")),
    ).toBeUndefined();
  });
});
