import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { scopedApprovalGrants } from "../../persistence/schema/index.js";
import {
  conversationWorkspaceCommandsEnabled,
  disableConversationWorkspaceCommands,
  upsertConversationToolGrant,
} from "../conversation-tool-grant.js";

await initializeDb();

function clearTables(): void {
  getDb().delete(scopedApprovalGrants).run();
}

describe("conversation-tool-grant", () => {
  beforeEach(() => clearTables());

  test("upsert is idempotent for the same conversation", () => {
    const first = upsertConversationToolGrant({
      conversationId: "conv-xyz",
      requestChannel: "cli",
      decisionChannel: "cli",
    });
    const second = upsertConversationToolGrant({
      conversationId: "conv-xyz",
      requestChannel: "cli",
      decisionChannel: "cli",
    });
    expect(second.id).toBe(first.id);
    expect(conversationWorkspaceCommandsEnabled("conv-xyz")).toBe(true);
  });

  test("disable revokes the standing grant", () => {
    upsertConversationToolGrant({
      conversationId: "conv-xyz",
      requestChannel: "http",
      decisionChannel: "http",
    });
    expect(disableConversationWorkspaceCommands("conv-xyz")).toBe(1);
    expect(conversationWorkspaceCommandsEnabled("conv-xyz")).toBe(false);
  });
});
