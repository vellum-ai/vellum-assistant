/**
 * Tests for the `subagents/reconcile` route handler, verifies that the
 * per-child payload carries enough detail (child conversationId, label,
 * objective, fork flag) for a client to rebuild its subagent list from
 * scratch after a reload, not just refresh statuses of entries it already has.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/356-add-subagent-parent-tool-use-id.js";
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

  test("keeps a terminal subagent the retention sweep evicted from memory", () => {
    upsertSubagentRecord(
      record({
        id: "sub-swept",
        conversationId: "child-conv-swept",
        label: "swept",
        status: "completed",
        completedAt: 2000,
        inputTokens: 90,
        outputTokens: 20,
        estimatedCost: 0.003,
      }),
    );
    // No `rehydrateFromDb()`: the row with no in-memory state IS the
    // post-sweep shape (`dispose(..., { keepRecord: true })`). Absence here
    // would read as "interrupted" to a client settling orphans by absence.

    expect(reconcile(PARENT_ID).subagents["sub-swept"]).toEqual({
      status: "completed",
      conversationId: "child-conv-swept",
      label: "swept",
      objective: "Research competitor pricing",
      isFork: false,
      usage: { inputTokens: 90, outputTokens: 20, estimatedCost: 0.003 },
    });
  });

  test("lets an in-memory child shadow its own durable row", () => {
    upsertSubagentRecord(record());
    // In-flight at rehydrate time → the manager settles it to `interrupted`.
    getSubagentManager().rehydrateFromDb();
    // A stale row claiming otherwise must not win: the live state is fresher.
    upsertSubagentRecord(
      record({ status: "completed", error: "stale", completedAt: 2000 }),
    );

    const entry = reconcile(PARENT_ID).subagents["sub-1"];
    expect(entry.status).toBe("interrupted");
    expect(entry.error).toBeUndefined();
  });

  test("settles an orphaned durable row still marked active", () => {
    // The startup window: `setDbReady(true)` precedes `rehydrateFromDb()`, so
    // a reconcile can read a pre-crash `running` row while the manager is
    // still empty. Nothing can be running without an in-memory entry.
    upsertSubagentRecord(record({ status: "running" }));
    upsertSubagentRecord(
      record({
        id: "sub-pending",
        conversationId: "child-conv-pending",
        label: "pending",
        status: "pending",
      }),
    );
    upsertSubagentRecord(
      record({
        id: "sub-awaiting",
        conversationId: "child-conv-awaiting",
        label: "awaiting",
        status: "awaiting_input",
      }),
    );
    // Deliberately no `rehydrateFromDb()`.

    const { subagents } = reconcile(PARENT_ID);
    expect(subagents["sub-1"].status).toBe("interrupted");
    expect(subagents["sub-pending"].status).toBe("interrupted");
    expect(subagents["sub-awaiting"].status).toBe("interrupted");
  });

  test("leaves an orphaned durable row's terminal status untouched", () => {
    for (const status of ["completed", "failed", "aborted", "interrupted"]) {
      upsertSubagentRecord(
        record({
          id: `sub-${status}`,
          conversationId: `child-conv-${status}`,
          label: status,
          status,
          completedAt: 2000,
        }),
      );
    }

    const { subagents } = reconcile(PARENT_ID);
    expect(subagents["sub-completed"].status).toBe("completed");
    expect(subagents["sub-failed"].status).toBe("failed");
    expect(subagents["sub-aborted"].status).toBe("aborted");
    expect(subagents["sub-interrupted"].status).toBe("interrupted");
  });

  test("does not settle an active child the manager still holds", () => {
    upsertSubagentRecord(record({ status: "running" }));
    const manager = getSubagentManager();
    manager.rehydrateFromDb();
    // A live entry means something IS driving the run, so its active status is
    // current rather than stale. `getState` hands back the manager's own state
    // object, the very one the route's live pass reads.
    manager.getState("sub-1")!.status = "running";

    expect(reconcile(PARENT_ID).subagents["sub-1"].status).toBe("running");
  });

  test("bounds the durable pass to the most recent terminal runs", () => {
    // Rows live as long as the conversation, so an old chat holds every
    // subagent it ever spawned, the snapshot must not ship the lot.
    for (let i = 0; i < 25; i++) {
      upsertSubagentRecord(
        record({
          id: `sub-done-${i}`,
          conversationId: `child-conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    // An unsettled row is never dropped, however old: the client's stuck-active
    // entry has to be settled no matter how much finished work came after it.
    upsertSubagentRecord(
      record({
        id: "sub-stale-active",
        conversationId: "child-conv-stale",
        label: "stale-active",
        status: "running",
        createdAt: 1,
        completedAt: null,
      }),
    );

    const { subagents } = reconcile(PARENT_ID);

    expect(subagents["sub-stale-active"].status).toBe("interrupted");
    const terminalIds = Object.keys(subagents)
      .filter((id) => id !== "sub-stale-active")
      .sort();
    expect(terminalIds).toEqual(
      Array.from({ length: 20 }, (_, i) => `sub-done-${i + 5}`).sort(),
    );
  });

  test("bounds the live pass after a restart rehydrates every row", () => {
    for (let i = 0; i < 25; i++) {
      upsertSubagentRecord(
        record({
          id: `sub-done-${i}`,
          conversationId: `child-conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    // Rehydration rebuilds terminal rows too, so for a whole retention window
    // after a restart the live pass sees more history than this snapshot ships.
    getSubagentManager().rehydrateFromDb();

    const { subagents } = reconcile(PARENT_ID);

    expect(Object.keys(subagents).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `sub-done-${i + 5}`).sort(),
    );
  });

  test("reports the recent terminal runs past the rehydration bound", () => {
    // Startup rehydration caps the terminal subagents it rebuilds in memory.
    // That bound is an in-process concern: this route reads the table, so its
    // own cap decides the payload and the answer must not move when memory
    // holds a different slice of the history.
    for (let i = 0; i < 210; i++) {
      upsertSubagentRecord(
        record({
          id: `sub-done-${String(i).padStart(3, "0")}`,
          conversationId: `child-conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    getSubagentManager().rehydrateFromDb();

    const { subagents } = reconcile(PARENT_ID);

    expect(Object.keys(subagents).sort()).toEqual(
      Array.from(
        { length: 20 },
        (_, i) => `sub-done-${String(i + 190).padStart(3, "0")}`,
      ).sort(),
    );
  });

  test("never caps out an active child, however old", () => {
    for (let i = 0; i < 25; i++) {
      upsertSubagentRecord(
        record({
          id: `sub-done-${i}`,
          conversationId: `child-conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    upsertSubagentRecord(
      record({
        id: "sub-old-active",
        conversationId: "child-conv-old-active",
        label: "old-active",
        status: "running",
        createdAt: 1,
        completedAt: null,
      }),
    );
    const manager = getSubagentManager();
    manager.rehydrateFromDb();
    // Something is driving this run again, so the live entry is authoritative,
    // and the oldest child of the parent, which the recency cap must not reach.
    manager.getState("sub-old-active")!.status = "running";

    const { subagents } = reconcile(PARENT_ID);

    expect(subagents["sub-old-active"].status).toBe("running");
    expect(Object.keys(subagents)).toHaveLength(21);
  });

  test("keeps a live terminal child past the bound the durable pass surfaced", () => {
    for (let i = 0; i < 21; i++) {
      upsertSubagentRecord(
        record({
          id: `sub-done-${String(i).padStart(2, "0")}`,
          conversationId: `child-conv-done-${i}`,
          label: `done-${i}`,
          status: "completed",
          completedAt: 10_000 + i,
        }),
      );
    }
    const manager = getSubagentManager();
    manager.rehydrateFromDb();
    // The two passes rank by their own copy of the recency key, so a child can
    // fall outside the live bound while the durable pass still ships its id.
    // Shipping it either way, the fresher live entry wins.
    const live = manager.getState("sub-done-20")!;
    live.completedAt = 1;
    live.error = "live";

    const { subagents } = reconcile(PARENT_ID);

    expect(subagents["sub-done-20"].error).toBe("live");
    expect(Object.keys(subagents)).toHaveLength(21);
  });

  test("omits a durable row whose status is out of enum", () => {
    upsertSubagentRecord(record({ status: "zombie" }));

    expect(reconcile(PARENT_ID).subagents).toEqual({});
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
