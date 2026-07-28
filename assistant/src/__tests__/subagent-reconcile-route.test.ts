/**
 * Tests for the `subagents/reconcile` route handler — verifies that the
 * per-child payload carries enough detail (child conversationId, label,
 * objective, fork flag) for a client to rebuild its subagent list from
 * scratch after a reload, not just refresh statuses of entries it already has.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/354-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { ROUTES } from "../runtime/routes/subagents-routes.js";
import { getSubagentManager } from "../subagent/index.js";

const PARENT_ID = "parent-reconcile-1";

function record(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sub-1",
    parentConversationId: PARENT_ID,
    conversationId: "child-conv-1",
    label: "research-pricing",
    objective: "Research competitor pricing",
    role: "researcher",
    isFork: false,
    sendResultToUser: true,
    parentToolUseId: null,
    status: "running",
    error: null,
    createdAt: 1000,
    startedAt: 1001,
    completedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    ...over,
  };
}

const reconcileRoute = ROUTES.find(
  (r) => r.operationId === "reconcileSubagents",
)!;

function reconcile(parentConversationId: string) {
  return reconcileRoute.handler({
    queryParams: { parentConversationId },
  } as Parameters<typeof reconcileRoute.handler>[0]) as {
    subagents: Record<string, Record<string, unknown>>;
  };
}

beforeEach(() => {
  migrateCreateSubagentsTable();
  migrateAddSubagentParentToolUseId(getDb());
  resetTestTables("subagents");
  getSubagentManager().disposeAll();
});

describe("reconcileSubagents route", () => {
  test("returns status plus child conversation id, label and objective", () => {
    upsertSubagentRecord(record());
    upsertSubagentRecord(
      record({
        id: "sub-2",
        conversationId: "child-conv-2",
        label: "fork-review",
        objective: "Review the diff",
        isFork: true,
        status: "completed",
        completedAt: 2000,
      }),
    );
    getSubagentManager().rehydrateFromDb();

    const { subagents } = reconcile(PARENT_ID);

    expect(Object.keys(subagents).sort()).toEqual(["sub-1", "sub-2"]);
    expect(subagents["sub-1"]).toEqual({
      // In-flight at rehydrate time → interrupted.
      status: "interrupted",
      conversationId: "child-conv-1",
      label: "research-pricing",
      objective: "Research competitor pricing",
      isFork: false,
    });
    expect(subagents["sub-2"]).toMatchObject({
      status: "completed",
      conversationId: "child-conv-2",
      label: "fork-review",
      isFork: true,
    });
  });

  test("includes parentToolUseId only when the spawn recorded one", () => {
    upsertSubagentRecord(record({ parentToolUseId: null }));
    upsertSubagentRecord(
      record({
        id: "sub-anchored",
        conversationId: "child-conv-anchored",
        label: "anchored",
        parentToolUseId: "toolu-abc",
      }),
    );
    getSubagentManager().rehydrateFromDb();

    const { subagents } = reconcile(PARENT_ID);
    expect(subagents["sub-1"].parentToolUseId).toBeUndefined();
    // The anchor is persisted, so it survives the restart `rehydrateFromDb`
    // models rather than silently dropping out of the response.
    expect(subagents["sub-anchored"].parentToolUseId).toBe("toolu-abc");
  });

  test("carries terminal usage and failure reason", () => {
    upsertSubagentRecord(
      record({
        id: "sub-failed",
        conversationId: "child-conv-failed",
        label: "failed-run",
        status: "failed",
        error: "provider timed out",
        completedAt: 2000,
        inputTokens: 1200,
        outputTokens: 340,
        estimatedCost: 0.021,
      }),
    );
    getSubagentManager().rehydrateFromDb();

    // The terminal `subagent_status_changed` is exactly the event a
    // reconciling client may have missed, so the snapshot has to carry what it
    // would have delivered.
    expect(reconcile(PARENT_ID).subagents["sub-failed"]).toMatchObject({
      status: "failed",
      error: "provider timed out",
      usage: { inputTokens: 1200, outputTokens: 340, estimatedCost: 0.021 },
    });
  });

  test("omits usage and error for a child that has spent nothing", () => {
    upsertSubagentRecord(record());
    getSubagentManager().rehydrateFromDb();

    const entry = reconcile(PARENT_ID).subagents["sub-1"];
    expect(entry.usage).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  test("returns an empty map for a parent with no known children", () => {
    upsertSubagentRecord(record());
    getSubagentManager().rehydrateFromDb();

    expect(reconcile("some-other-parent").subagents).toEqual({});
  });

  test("rejects a request without parentConversationId", () => {
    expect(() => reconcile("")).toThrow(
      "parentConversationId query parameter is required",
    );
  });
});
