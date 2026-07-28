import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/355-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  deleteSubagentRecordsByParent,
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
    parentToolUseId: null,
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
  migrateAddSubagentParentToolUseId(getDb());
  resetTestTables("subagents");
});

describe("subagent-store", () => {
  test("round-trips a record, mapping booleans and nullable fields", () => {
    upsertSubagentRecord(
      record({
        isFork: true,
        sendResultToUser: null,
        error: null,
        parentToolUseId: "toolu-abc",
      }),
    );

    const rows = loadAllSubagentRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      isFork: true,
      sendResultToUser: null,
      parentToolUseId: "toolu-abc",
      role: "researcher",
      status: "running",
      inputTokens: 5,
    });
  });

  test("a spawn with no anchoring tool call stores a null parentToolUseId", () => {
    upsertSubagentRecord(record({ parentToolUseId: null }));

    expect(loadAllSubagentRecords()[0].parentToolUseId).toBeNull();
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

  test("delete by parent removes only that parent's records", () => {
    upsertSubagentRecord(record());
    upsertSubagentRecord(
      record({ id: "s2", parentConversationId: "parent-2", label: "other" }),
    );

    deleteSubagentRecordsByParent("parent-1");

    expect(loadAllSubagentRecords().map((r) => r.id)).toEqual(["s2"]);
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

  test("restores the spawn tool-call anchor onto rehydrated config", () => {
    upsertSubagentRecord(
      record({ id: "anchored", label: "anchored", parentToolUseId: "toolu-1" }),
    );
    upsertSubagentRecord(
      record({ id: "loose", label: "loose", parentToolUseId: null }),
    );

    const mgr = new SubagentManager();
    mgr.rehydrateFromDb();

    expect(mgr.getState("anchored")?.config.parentToolUseId).toBe("toolu-1");
    expect(mgr.getState("loose")?.config.parentToolUseId).toBeUndefined();

    // The anchor survives the interrupted re-persist a rehydrate performs.
    expect(
      loadAllSubagentRecords().find((r) => r.id === "anchored")
        ?.parentToolUseId,
    ).toBe("toolu-1");

    mgr.disposeAll();
  });

  test("returns zero counts when there are no persisted records", () => {
    const mgr = new SubagentManager();
    expect(mgr.rehydrateFromDb()).toEqual({ rehydrated: 0, interrupted: 0 });
    mgr.disposeAll();
  });
});
