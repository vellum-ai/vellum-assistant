/**
 * A conversation's durable subagent rows are purged only after the conversation
 * delete commits. The rows are a child's only durable metadata, so dropping
 * them first would lose them for good when the delete throws — while the
 * conversation they describe survives, intact for a retried delete.
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

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { migrateCreateSubagentsTable } from "../persistence/migrations/311-create-subagents-table.js";
import { migrateAddSubagentParentToolUseId } from "../persistence/migrations/354-add-subagent-parent-tool-use-id.js";
import { resetTestTables } from "../persistence/raw-query.js";
import {
  getSubagentRecordById,
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

describe("DELETE /conversations/:id — subagent row purge order", () => {
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
