/**
 * A conversation's durable subagent rows are purged inside the conversation
 * delete's own transaction. The rows are a child's only durable metadata, so a
 * delete that fails has to leave them addressable: the conversation they
 * describe survives too, intact for a retried delete.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  resolveMetaSlashCommand: () => null,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/356-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  deleteAllSubagentRecords,
  getSubagentRecordById,
  loadAllSubagentRecords,
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";

await initializeDb();

// Captured before the mock replaces the export, so the happy path still runs
// the real delete.
const crud = await import("../persistence/conversation-crud.js");
const createConversation = crud.createConversation;
const getConversation = crud.getConversation;
const realDeleteConversation = crud.deleteConversation;
const realDeleteConversationGently = crud.deleteConversationGently;

let failNextDelete = false;
mock.module("../persistence/conversation-crud.js", () => ({
  ...crud,
  deleteConversation: (id: string) => {
    if (failNextDelete) {
      throw new Error("simulated delete failure");
    }
    return realDeleteConversation(id);
  },
}));

const { ROUTES } =
  await import("../runtime/routes/conversation-management-routes.js");
const deleteRoute = ROUTES.find((r) => r.operationId === "deleteConversation")!;

// Deferred until after the mocks so the manager and its transitive deps load
// against the same module registry the routes above use.
const { SubagentManager } = await import("../subagent/manager.js");
const { deleteConversationById } =
  await import("../runtime/routes/playground/helpers.js");

function seedRow(id: string, parentConversationId: string): void {
  const rec: SubagentRecord = {
    id,
    parentConversationId,
    conversationId: `child-conv-${id}`,
    label: id,
    objective: "Do something",
    role: "researcher",
    isFork: false,
    sendResultToUser: null,
    parentToolUseId: null,
    status: "completed",
    error: null,
    createdAt: 1000,
    startedAt: 1001,
    completedAt: 2000,
    inputTokens: 5,
    outputTokens: 7,
    estimatedCost: 0.01,
  };
  upsertSubagentRecord(rec);
}

function deleteConversationViaRoute(id: string): Promise<unknown> {
  return deleteRoute.handler({
    pathParams: { id },
    body: {},
    headers: {},
  } as Parameters<typeof deleteRoute.handler>[0]) as Promise<unknown>;
}

describe("DELETE /conversations/:id - subagent row purge order", () => {
  beforeEach(() => {
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
    failNextDelete = false;
  });

  test("purges the parent's rows once the delete commits", async () => {
    const conv = createConversation("subagent-parent");
    const other = createConversation("unrelated-parent");
    seedRow("child-a", conv.id);
    seedRow("child-b", conv.id);
    seedRow("child-other", other.id);

    await deleteConversationViaRoute(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getSubagentRecordById("child-a")).toBeUndefined();
    expect(getSubagentRecordById("child-b")).toBeUndefined();
    expect(getSubagentRecordById("child-other")).toBeDefined();
  });

  test("keeps the rows when the conversation delete throws", async () => {
    const conv = createConversation("failing-parent");
    seedRow("child-kept", conv.id);
    failNextDelete = true;

    await expect(deleteConversationViaRoute(conv.id)).rejects.toThrow(
      "simulated delete failure",
    );

    // The conversation is still there for a retried delete, so its children's
    // only durable metadata has to still be there too.
    expect(getConversation(conv.id)).not.toBeNull();
    expect(getSubagentRecordById("child-kept")).toBeDefined();
  });
});

describe("deleteConversation purges subagent rows transactionally", () => {
  beforeEach(() => {
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
    failNextDelete = false;
  });

  test("the persistence primitive purges the parent's rows on its own", () => {
    const conv = createConversation("primitive-parent");
    const other = createConversation("primitive-unrelated-parent");
    seedRow("child-primitive", conv.id);
    seedRow("child-primitive-other", other.id);

    realDeleteConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getSubagentRecordById("child-primitive")).toBeUndefined();
    expect(getSubagentRecordById("child-primitive-other")).toBeDefined();
  });

  test("a mid-transaction failure rolls the purge back with the delete", () => {
    const conv = createConversation("rollback-parent");
    seedRow("child-rollback", conv.id);

    // Abort the transaction after it has begun and after the row purge has
    // already run, so only a shared transaction can undo the purge.
    getSqlite().exec(
      "CREATE TRIGGER t_fail BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      expect(() => realDeleteConversation(conv.id)).toThrow();
    } finally {
      getSqlite().exec("DROP TRIGGER t_fail");
    }

    // Both survive, so a retried delete still resolves the conversation and
    // still finds its children's durable metadata.
    expect(getConversation(conv.id)).not.toBeNull();
    expect(getSubagentRecordById("child-rollback")).toBeDefined();

    realDeleteConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getSubagentRecordById("child-rollback")).toBeUndefined();
  });

  test("a failed row purge takes the conversation delete down with it", () => {
    const conv = createConversation("purge-failure-parent");
    seedRow("child-purge-failure", conv.id);

    // The purge is the failing statement here, so a conversation row that
    // survived would be one whose children's metadata is unreachable.
    getSqlite().exec(
      "CREATE TRIGGER t_purge_fail BEFORE DELETE ON subagents BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      expect(() => realDeleteConversation(conv.id)).toThrow();
    } finally {
      getSqlite().exec("DROP TRIGGER t_purge_fail");
    }

    expect(getConversation(conv.id)).not.toBeNull();
    expect(getSubagentRecordById("child-purge-failure")).toBeDefined();
  });
});

describe("deleteConversationGently purges subagent rows too", () => {
  beforeEach(() => {
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
  });

  test("the gentle path purges the parent's rows", async () => {
    // The memory plugin deletes retrospective forks and orphans through this
    // path. Rows it left behind outlive their parent conversation forever and
    // are rehydrated on every restart.
    const conv = createConversation("gentle-parent");
    const other = createConversation("gentle-unrelated-parent");
    seedRow("child-gentle", conv.id);
    seedRow("child-gentle-other", other.id);

    await realDeleteConversationGently(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getSubagentRecordById("child-gentle")).toBeUndefined();
    expect(getSubagentRecordById("child-gentle-other")).toBeDefined();
  });
});

describe("playground delete leaves the rows to the conversation transaction", () => {
  beforeEach(() => {
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
    failNextDelete = false;
  });

  test("a failed delete keeps the conversation and its rows for a retry", () => {
    const conv = createConversation("playground-parent");
    const other = createConversation("playground-unrelated-parent");
    seedRow("child-playground", conv.id);
    seedRow("child-playground-other", other.id);

    // Abort the conversation transaction, so an in-memory teardown that
    // deleted the rows eagerly would have committed that delete already.
    getSqlite().exec(
      "CREATE TRIGGER t_pg_fail BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      expect(() => deleteConversationById(conv.id)).toThrow();
    } finally {
      getSqlite().exec("DROP TRIGGER t_pg_fail");
    }

    expect(getConversation(conv.id)).not.toBeNull();
    expect(getSubagentRecordById("child-playground")).toBeDefined();

    expect(deleteConversationById(conv.id)).toBe(true);

    expect(getConversation(conv.id)).toBeNull();
    expect(getSubagentRecordById("child-playground")).toBeUndefined();
    expect(getSubagentRecordById("child-playground-other")).toBeDefined();
  });
});

describe("clear-all defers subagent-row deletion to the DB wipe", () => {
  beforeEach(() => {
    migrateCreateSubagentsTable();
    migrateAddSubagentParentToolUseId(getDb());
    resetTestTables("subagents");
  });

  test("keepRecords teardown leaves the rows for the ordered DB wipe", () => {
    // clear-all tears the manager down in memory first, then `clearAll()` wipes
    // the DB in retry-safe order (conversations, then subagents). If the
    // in-memory teardown deleted the rows eagerly, a `clearAll()` that threw
    // would strand conversations with no subagent metadata, so the teardown
    // must leave the rows for the ordered wipe.
    seedRow("child-a", "parent-1");
    seedRow("child-b", "parent-1");
    seedRow("child-c", "parent-2");

    const manager = new SubagentManager();
    manager.disposeAllForAllParents({ keepRecords: true });

    // The in-memory teardown has run, but no DB wipe has followed, so every
    // durable row is still addressable.
    expect(loadAllSubagentRecords()).toHaveLength(3);
    expect(getSubagentRecordById("child-a")).toBeDefined();
    expect(getSubagentRecordById("child-b")).toBeDefined();
    expect(getSubagentRecordById("child-c")).toBeDefined();
  });

  test("the deferred DB wipe still removes the rows", () => {
    // Happy path: once the teardown has kept the rows, the `clearAll()` DB wipe
    // (its `DELETE FROM subagents`) is what actually clears them.
    seedRow("child-a", "parent-1");

    const manager = new SubagentManager();
    manager.disposeAllForAllParents({ keepRecords: true });
    expect(loadAllSubagentRecords()).toHaveLength(1);

    deleteAllSubagentRecords();
    expect(loadAllSubagentRecords()).toHaveLength(0);
  });
});
