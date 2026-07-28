import { beforeEach, describe, expect, test } from "bun:test";

import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  deleteSubagentRecord,
  loadAllSubagentRecords,
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { SubagentManager } from "../subagent/manager.js";

function record(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "s1",
    parentConversationId: "parent-1",
    conversationId: "conv-1",
    label: "research-pricing",
    objective: "Research competitor pricing",
    role: "researcher",
    isFork: false,
    sendResultToUser: true,
    status: "running",
    error: null,
    createdAt: 1000,
    startedAt: 1001,
    completedAt: null,
    inputTokens: 5,
    outputTokens: 7,
    estimatedCost: 0.01,
    ...over,
  };
}

beforeEach(() => {
  // Idempotent; the table may already exist from a prior run.
  migrateCreateSubagentsTable();
  resetTestTables("subagents");
});

describe("subagent-store", () => {
  test("round-trips a record, mapping booleans and nullable fields", () => {
    upsertSubagentRecord(
      record({ isFork: true, sendResultToUser: null, error: null }),
    );

    const rows = loadAllSubagentRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      isFork: true,
      sendResultToUser: null,
      role: "researcher",
      status: "running",
      inputTokens: 5,
    });
  });

  test("upsert refreshes mutable lifecycle fields on conflict", () => {
    upsertSubagentRecord(record({ status: "running" }));
    upsertSubagentRecord(
      record({ status: "completed", completedAt: 2000, outputTokens: 99 }),
    );

    const rows = loadAllSubagentRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].completedAt).toBe(2000);
    expect(rows[0].outputTokens).toBe(99);
  });

  test("delete removes the record", () => {
    upsertSubagentRecord(record());
    deleteSubagentRecord("s1");
    expect(loadAllSubagentRecords()).toHaveLength(0);
  });
});

describe("SubagentManager.rehydrateFromDb", () => {
  test("marks in-flight subagents interrupted and loads terminal ones as-is", () => {
    upsertSubagentRecord(
      record({ id: "running-1", label: "still-running", status: "running" }),
    );
    upsertSubagentRecord(
      record({
        id: "done-1",
        label: "finished",
        status: "completed",
        completedAt: 2000,
      }),
    );

    const mgr = new SubagentManager();
    const { rehydrated, interrupted } = mgr.rehydrateFromDb();

    expect(rehydrated).toBe(2);
    expect(interrupted).toBe(1);

    // In-flight → interrupted (not auto-resumed); terminal loads unchanged.
    expect(mgr.getState("running-1")?.status).toBe("interrupted");
    expect(mgr.getState("done-1")?.status).toBe("completed");

    // Reachable by label and parent, like a live subagent.
    expect(mgr.getByLabel("still-running", "parent-1")?.config.id).toBe(
      "running-1",
    );
    expect(mgr.getChildrenOf("parent-1")).toHaveLength(2);

    // The interrupted transition is persisted, so a second rehydrate is a no-op.
    expect(
      loadAllSubagentRecords().find((r) => r.id === "running-1")?.status,
    ).toBe("interrupted");

    mgr.disposeAll();
  });

  test("returns zero counts when there are no persisted records", () => {
    const mgr = new SubagentManager();
    expect(mgr.rehydrateFromDb()).toEqual({ rehydrated: 0, interrupted: 0 });
    mgr.disposeAll();
  });
});
