/**
 * Asserts `listConsolidationRuns` maps background-conversation rows tagged
 * with `source = MEMORY_V2_CONSOLIDATION_SOURCE` into the heartbeat-runs
 * response shape, derives `status` / `finishedAt` / `durationMs` from
 * **assistant-message presence** (not `lastMessageAt`), and clamps the
 * `limit` query param.
 *
 * Synthetic-field semantics covered here:
 *   - `id` and `conversationId` both equal the conversation row's id.
 *   - `scheduledFor` and `startedAt` both equal `conversation.createdAt`
 *     (no separate schedule timestamp on the row).
 *   - `finishedAt` is the `createdAt` of the LATEST assistant message,
 *     NOT `conversation.lastMessageAt` — the kickoff user prompt bumps
 *     `lastMessageAt` before the agent runs, so it cannot be used as a
 *     completion signal.
 *   - `durationMs` is `finishedAt − startedAt` when both are present, else
 *     null.
 *   - `status` is `"ok"` when the conversation has at least one assistant
 *     message (positive evidence the agent emitted output) and `"running"`
 *     otherwise — including the case where only the kickoff user prompt
 *     has been persisted.
 *   - `skipReason` and `error` are always null — the conversation row
 *     alone cannot distinguish a clean run from a mid-flight crash even
 *     once assistant output exists.
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
import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb, getMemorySqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { recordUsageEvent } from "../../../persistence/llm-usage-store.js";
import { rawRun } from "../../../persistence/raw-query.js";
import { ROUTES } from "../consolidation-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

// Open the memory connection now, while VELLUM_WORKSPACE_DIR still points at the
// migrated per-process workspace. The per-test blocks below swap it to a fresh
// dir for config isolation; without pinning here, resetTables()'s first
// getMemorySqlite() would lazily open assistant-memory.db in the swapped (empty)
// workspace and fail with "no such table: memory_jobs".
getMemorySqlite();

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let configPath: string;

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM llm_usage_events`);
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
  getMemorySqlite()!.run(`DELETE FROM memory_jobs`);
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
    "test:insertMessage",
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    `msg-${conversationId}-${role}-${createdAt}`,
    conversationId,
    role,
    "x",
    createdAt,
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
    "test:setUsageCreatedAt",
    "UPDATE llm_usage_events SET created_at = ? WHERE id = ?",
    createdAt,
    event.id,
  );
}

function readMemoryJobRows(): Array<{
  id: string;
  status: string;
  lastError: string | null;
  payload: string;
}> {
  return getMemorySqlite()!
    .query(
      `
    SELECT id, status, last_error AS lastError, payload
    FROM memory_jobs
    ORDER BY id
  `,
    )
    .all() as Array<{
    id: string;
    status: string;
    lastError: string | null;
    payload: string;
  }>;
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
}

interface ListRunsResponse {
  runs: RunRecord[];
}

describe("listConsolidationRuns handler", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "vellum-consolidation-routes-"));
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

  test("returns only conversations sourced from memory_v2_consolidation", async () => {
    createConversation({ title: "c1", source: "memory_v2_consolidation" });
    createConversation({ title: "h1", source: "heartbeat" });
    createConversation({ title: "u1", source: "user" });

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
  });

  test("synthesizes status='ok' with finishedAt from latest assistant message", async () => {
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "test:setCreatedAt",
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      1000,
      conv.id,
    );
    // Kickoff user prompt at t=1100 (bumps lastMessageAt — must NOT be
    // mistaken for completion).
    insertMessage(conv.id, "user", 1100);
    // Agent's first assistant turn at t=2000.
    insertMessage(conv.id, "assistant", 2000);
    // Agent's final assistant turn at t=2500.
    insertMessage(conv.id, "assistant", 2500);

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.id).toBe(conv.id);
    expect(run.conversationId).toBe(conv.id);
    expect(run.status).toBe("ok");
    expect(run.scheduledFor).toBe(1000);
    expect(run.startedAt).toBe(1000);
    // finishedAt = createdAt of LATEST assistant message (2500), NOT
    // the conversation's lastMessageAt (which sqlite triggers may or may
    // not have updated here — irrelevant to this endpoint).
    expect(run.finishedAt).toBe(2500);
    expect(run.durationMs).toBe(1500);
    expect(run.createdAt).toBe(1000);
  });

  test("exposes estimatedCostUsd from the conversation total when available", async () => {
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "test:setCreatedAtAndCost",
      "UPDATE conversations SET created_at = ?, total_estimated_cost = ? WHERE id = ?",
      1000,
      0.42,
      conv.id,
    );
    insertMessage(conv.id, "assistant", 2000);
    recordUsageCostAt(conv.id, "consolidation-fallback-cost", 1500, 0.99);

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs[0]!.estimatedCostUsd).toBeCloseTo(0.42);
  });

  test("falls back to conversation-window usage cost when the total is empty", async () => {
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "test:setCreatedAt",
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      1000,
      conv.id,
    );
    insertMessage(conv.id, "assistant", 2000);
    recordUsageCostAt(conv.id, "consolidation-before", 999, 0.4);
    recordUsageCostAt(conv.id, "consolidation-inside", 1500, 0.07);
    recordUsageCostAt(conv.id, "consolidation-after", 2001, 0.5);

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs[0]!.estimatedCostUsd).toBeCloseTo(0.07);
  });

  test("synthesizes status='running' when conversation has no assistant message", async () => {
    createConversation({ title: "c1", source: "memory_v2_consolidation" });

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect(run.durationMs).toBeNull();
  });

  test("status stays 'running' when only the kickoff user prompt exists (Codex bug regression guard)", async () => {
    // Regression guard for the original `status from lastMessageAt`
    // heuristic. `processMessage` persists the background kickoff prompt as
    // a user message BEFORE the agent runs, which bumps
    // `conversation.lastMessageAt`. A run that timed out / threw before
    // emitting any assistant turn must still report status='running' (or
    // an explicit failure status once one exists) — never 'ok'.
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "test:setCreatedAtAndLastMsg",
      "UPDATE conversations SET created_at = ?, last_message_at = ? WHERE id = ?",
      1000,
      1100,
      conv.id,
    );
    insertMessage(conv.id, "user", 1100);

    const handler = findHandler("listConsolidationRuns");
    const result = (await handler({})) as ListRunsResponse;

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect(run.durationMs).toBeNull();
  });

  test("skipReason and error are always null (not derivable from conversation row)", async () => {
    const conv = createConversation({
      title: "c1",
      source: "memory_v2_consolidation",
    });
    insertMessage(conv.id, "assistant", 2000);

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
    rawRun(
      "test:setCreatedAt",
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      1000,
      a.id,
    );
    rawRun(
      "test:setCreatedAt",
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      3000,
      b.id,
    );
    rawRun(
      "test:setCreatedAt",
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      2000,
      c.id,
    );

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

describe("consolidation config and run-now handlers", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "vellum-consolidation-routes-"));
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

  test("reports consolidation unavailable when global memory is disabled", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          memory: {
            enabled: false,
            v2: {
              enabled: true,
              consolidation_interval_hours: 4,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const handler = findHandler("getConsolidationConfig");
    const result = (await handler({})) as {
      available: boolean;
      enabled: boolean;
      intervalMs: number;
      nextRunAt: number | null;
      success: boolean;
    };

    expect(result).toMatchObject({
      available: false,
      enabled: false,
      intervalMs: 4 * 60 * 60 * 1000,
      nextRunAt: null,
      success: true,
    });
  });

  test("run-now is unavailable when global memory is disabled", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          memory: {
            enabled: false,
            v2: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const handler = findHandler("runConsolidationNow");
    await expect(handler({})).rejects.toThrow("Consolidation is not available");
  });

  test("run-now remains available when memory v2 is enabled", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          memory: {
            v2: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const handler = findHandler("runConsolidationNow");
    const result = (await handler({})) as {
      success: boolean;
      ran: boolean;
      jobId: string | null;
    };

    expect(result.success).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.jobId).toBeString();
    const row = readMemoryJobRows().find((job) => job.id === result.jobId);
    expect(row?.payload).toBe(JSON.stringify({ trigger: "manual" }));
  });
});
