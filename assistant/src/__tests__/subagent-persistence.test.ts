import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
import { getSubagentManager } from "../subagent/index.js";
import {
  SubagentManager,
  subagentStateFromRecord,
} from "../subagent/manager.js";
import {
  normalizeSubagentLabel,
  settleUnsupervisedStatus,
  type SubagentState,
} from "../subagent/types.js";
import { resolveSubagentId } from "../tools/subagent/resolve.js";
import type { ToolContext } from "../tools/types.js";

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

  test("a label matches case-insensitively past ASCII", () => {
    // SQLite's `lower()` folds ASCII only, so a SQL predicate misses a label
    // the manager's Unicode-aware index matches, and the durable path would
    // stop answering the moment the in-memory entry is gone.
    upsertSubagentRecord(
      record({
        id: "accented",
        conversationId: "conv-accented",
        label: "ÉTAPE",
      }),
    );

    expect(
      getSubagentRecordByLabel("parent-1", normalizeSubagentLabel("étape"))?.id,
    ).toBe("accented");
    expect(
      getSubagentRecordByLabel("parent-1", normalizeSubagentLabel("  Étape "))
        ?.id,
    ).toBe("accented");
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

  test("a label tied on spawn time resolves to the last one spawned", () => {
    // `created_at` is millisecond-resolution, so two subagents spawned in the
    // same tick are indistinguishable by it and the durable paths need the
    // row's insertion order to reach the same last-spawn-wins answer the live
    // index gives. The earlier spawn finishes last here, so both a
    // completion-ordered walk and a `created_at`-only comparison pick it.
    upsertSubagentRecord(
      record({
        id: "tie-first",
        conversationId: "conv-tie-first",
        label: "Tied worker",
        status: "completed",
        createdAt: 1000,
        completedAt: 5000,
      }),
    );
    upsertSubagentRecord(
      record({
        id: "tie-second",
        conversationId: "conv-tie-second",
        label: "Tied worker",
        status: "completed",
        createdAt: 1000,
        completedAt: 3000,
      }),
    );

    expect(
      getSubagentRecordByLabel(
        "parent-1",
        normalizeSubagentLabel("Tied worker"),
      )?.id,
    ).toBe("tie-second");

    const mgr = new SubagentManager();
    mgr.rehydrateFromDb();

    expect(mgr.getByLabel("Tied worker", "parent-1")?.config.id).toBe(
      "tie-second",
    );

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

/** The manager internals a label lookup reads. */
interface LabelLookupInternals {
  subagents: Map<
    string,
    {
      conversation: null;
      state: SubagentState;
      parentSendToClient: () => void;
    }
  >;
  parentToChildren: Map<string, Set<string>>;
  labelIndex: Map<string, string>;
}

/** Ids injected into the shared manager, torn down after each test. */
const heldIds: string[] = [];

/**
 * Put a record's state into the shared manager under its label, the shape a
 * subagent has once its conversation is released: metadata only, no live run.
 */
function holdInMemory(rec: SubagentRecord): void {
  const internals = getSubagentManager() as unknown as LabelLookupInternals;
  internals.subagents.set(rec.id, {
    conversation: null,
    state: subagentStateFromRecord(rec),
    parentSendToClient: () => {},
  });
  internals.labelIndex.set(
    `${rec.parentConversationId}:${normalizeSubagentLabel(rec.label)}`,
    rec.id,
  );
  if (!internals.parentToChildren.has(rec.parentConversationId)) {
    internals.parentToChildren.set(rec.parentConversationId, new Set());
  }
  internals.parentToChildren.get(rec.parentConversationId)!.add(rec.id);
  heldIds.push(rec.id);
}

function toolContext(conversationId: string): ToolContext {
  return { conversationId, workingDir: "/tmp", trustClass: "guardian" };
}

afterEach(() => {
  const mgr = getSubagentManager();
  for (const id of heldIds.splice(0)) {
    mgr.dispose(id);
  }
});

describe("resolveSubagentId by label", () => {
  test("prefers the newer spawn that only the durable rows still hold", () => {
    // Which runs the manager holds is decided by completion time and by the
    // startup rehydration bound, so an older spawn can be the one left in
    // memory under the label while the newer spawn survives only as a row.
    const spawnedFirst = record({
      id: "spawned-first",
      conversationId: "conv-spawned-first",
      label: "Shared worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 5000,
    });
    const spawnedSecond = record({
      id: "spawned-second",
      conversationId: "conv-spawned-second",
      label: "Shared worker",
      status: "completed",
      createdAt: 2000,
      completedAt: 3000,
    });
    upsertSubagentRecord(spawnedFirst);
    upsertSubagentRecord(spawnedSecond);
    holdInMemory(spawnedFirst);

    expect(
      resolveSubagentId({ label: "Shared worker" }, toolContext("parent-1")),
    ).toBe("spawned-second");
  });

  test("resolves a run held by both sources to that one run", () => {
    const both = record({
      id: "same-run",
      conversationId: "conv-same-run",
      label: "Solo worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 2000,
    });
    upsertSubagentRecord(both);
    holdInMemory(both);

    expect(
      resolveSubagentId({ label: "Solo worker" }, toolContext("parent-1")),
    ).toBe("same-run");
  });

  test("resolves a live label with no durable row yet", () => {
    const fresh = record({
      id: "just-spawned",
      conversationId: "conv-just-spawned",
      label: "Fresh worker",
      status: "running",
      createdAt: 9000,
    });
    holdInMemory(fresh);

    expect(
      resolveSubagentId({ label: "Fresh worker" }, toolContext("parent-1")),
    ).toBe("just-spawned");
  });

  test("breaks a same-millisecond tie by durable insertion order", () => {
    // Both runs persisted, so the live entry was itself a candidate in the
    // durable lookup and its insertion order already decided the tie. Holding
    // the earlier one in memory must not override that.
    const held = record({
      id: "tie-held",
      conversationId: "conv-tie-held",
      label: "Tied worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 5000,
    });
    const laterSpawn = record({
      id: "tie-later-spawn",
      conversationId: "conv-tie-later-spawn",
      label: "Tied worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 3000,
    });
    upsertSubagentRecord(held);
    upsertSubagentRecord(laterSpawn);
    holdInMemory(held);

    expect(
      resolveSubagentId({ label: "Tied worker" }, toolContext("parent-1")),
    ).toBe("tie-later-spawn");
  });

  test("keeps an unpersisted live spawn on a same-millisecond tie", () => {
    // A live entry with no row has not persisted yet, which only a spawn still
    // in flight can be, so it is the later spawn even on a tie.
    const persisted = record({
      id: "tie-persisted",
      conversationId: "conv-tie-persisted",
      label: "Tied worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 3000,
    });
    const inFlight = record({
      id: "tie-in-flight",
      conversationId: "conv-tie-in-flight",
      label: "Tied worker",
      status: "running",
      createdAt: 1000,
    });
    upsertSubagentRecord(persisted);
    holdInMemory(inFlight);

    expect(
      resolveSubagentId({ label: "Tied worker" }, toolContext("parent-1")),
    ).toBe("tie-in-flight");
  });
});
