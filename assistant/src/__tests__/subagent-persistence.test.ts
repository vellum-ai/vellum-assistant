import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/356-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  deleteSubagentRecordsByParent,
  getSubagentRecordById,
  getSubagentRecordByLabel,
  loadAllSubagentRecords,
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import {
  settleUnsupervisedStatus,
  SubagentManager,
  subagentStateFromRecord,
} from "../subagent/manager.js";
import { normalizeSubagentLabel } from "../subagent/types.js";

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

/** Mirrors `MAX_REHYDRATED_TERMINAL_RECORDS` in `subagent/manager.ts`. */
const REHYDRATION_CAP = 200;

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

describe("subagentStateFromRecord", () => {
  test("maps the recorded status verbatim, leaving the settle to the caller", () => {
    upsertSubagentRecord(record({ id: "active", status: "running" }));

    const rec = loadAllSubagentRecords()[0];
    expect(subagentStateFromRecord(rec).status).toBe("running");
    expect(settleUnsupervisedStatus("running")).toBe("interrupted");
    expect(settleUnsupervisedStatus("completed")).toBe("completed");
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

  test("a label reused across runs resolves to the newest one", () => {
    // The durable query hands terminal rows back newest-first, so a label
    // claimed unconditionally as the loop walks them ends up held by the
    // OLDEST run and `subagent_read`/`subagent_status` answer for a stale one.
    upsertSubagentRecord(
      record({
        id: "reused-old",
        conversationId: "conv-reused-old",
        label: "Reused worker",
        status: "completed",
        createdAt: 1000,
        completedAt: 2000,
      }),
    );
    upsertSubagentRecord(
      record({
        id: "reused-new",
        conversationId: "conv-reused-new",
        label: "Reused worker",
        status: "completed",
        createdAt: 3000,
        completedAt: 4000,
      }),
    );

    const mgr = new SubagentManager();
    mgr.rehydrateFromDb();

    expect(mgr.getByLabel("Reused worker", "parent-1")?.config.id).toBe(
      "reused-new",
    );
    // Both runs stay addressable by id; only the label moved.
    expect(mgr.getState("reused-old")?.status).toBe("completed");

    mgr.disposeAll();
  });

  test("a label shared by concurrent runs resolves to the last one spawned", () => {
    // Two live subagents sharing a label: `spawn()` hands the label to the
    // newest one, so the durable paths have to agree even when the runs finish
    // out of spawn order. Ordering by completion resolves the label to the
    // older run here and serves its stale output.
    upsertSubagentRecord(
      record({
        id: "spawned-first",
        conversationId: "conv-spawned-first",
        label: "Concurrent worker",
        status: "completed",
        createdAt: 1000,
        completedAt: 5000,
      }),
    );
    upsertSubagentRecord(
      record({
        id: "spawned-second",
        conversationId: "conv-spawned-second",
        label: "Concurrent worker",
        status: "completed",
        createdAt: 2000,
        completedAt: 3000,
      }),
    );

    const mgr = new SubagentManager();
    mgr.rehydrateFromDb();

    expect(mgr.getByLabel("Concurrent worker", "parent-1")?.config.id).toBe(
      "spawned-second",
    );
    expect(
      getSubagentRecordByLabel(
        "parent-1",
        normalizeSubagentLabel("Concurrent worker"),
      )?.id,
    ).toBe("spawned-second");

    mgr.disposeAll();
  });

  test("loads only the most recent terminal records, plus every unsettled one", () => {
    // Rows live as long as the parent conversation, so an old chat accumulates
    // them without limit and a boot that materialized the lot would scale its
    // startup work with the whole history.
    for (let i = 0; i < REHYDRATION_CAP + 5; i++) {
      upsertSubagentRecord(
        record({
          id: `done-${i}`,
          conversationId: `conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    // Older than every terminal row above and never settled: no cap may reach
    // it, or the process forgets a subagent it still owes an `interrupted`.
    upsertSubagentRecord(
      record({
        id: "stale-active",
        conversationId: "conv-stale-active",
        label: "stale-active",
        status: "running",
        createdAt: 1,
        completedAt: null,
      }),
    );

    const mgr = new SubagentManager();
    const { rehydrated, interrupted } = mgr.rehydrateFromDb();

    expect(rehydrated).toBe(REHYDRATION_CAP + 1);
    expect(interrupted).toBe(1);
    expect(mgr.getState("stale-active")?.status).toBe("interrupted");

    const terminalIds = mgr
      .getChildrenOf("parent-1")
      .map((child) => child.config.id)
      .filter((id) => id !== "stale-active")
      .sort();
    expect(terminalIds).toEqual(
      Array.from({ length: REHYDRATION_CAP }, (_, i) => `done-${i + 5}`).sort(),
    );

    // The five oldest fell outside the bound. They are gone from memory and
    // still durable, which is what the record-backed route surfaces read.
    for (let i = 0; i < 5; i++) {
      expect(mgr.getState(`done-${i}`)).toBeUndefined();
      expect(getSubagentRecordById(`done-${i}`)?.status).toBe("completed");
    }

    mgr.disposeAll();
  });
});
