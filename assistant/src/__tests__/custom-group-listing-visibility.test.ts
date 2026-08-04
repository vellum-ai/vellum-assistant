import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigration } from "../persistence/conversation-group-migration.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createGroup } from "../persistence/group-crud.js";

await initializeDb();
ensureGroupMigration();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * Custom-group arm of standard-listing visibility: a row filed into a
 * user-created group renders in the standard (Recents) listing regardless of
 * conversation type, so custom groups survive a cold sidebar load. System
 * groups keep the type-based exclusions, and private/subagent rows stay
 * hidden unconditionally.
 */
describe("custom-group standard-listing visibility", () => {
  let groupId: string;

  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM conversations");
    raw.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
    groupId = createGroup("Briefs").id;
  });

  function listedIds(): string[] {
    return listConversations(undefined, "standard").map((c) => c.id);
  }

  test("scheduled conversation in a custom group is listed", () => {
    createConversation({
      id: "conv-sched-custom",
      conversationType: "scheduled",
      source: "schedule",
      groupId,
    });

    expect(listedIds()).toContain("conv-sched-custom");
  });

  test("background conversation in a custom group is listed", () => {
    createConversation({
      id: "conv-bg-custom",
      conversationType: "background",
      source: "task",
      groupId,
    });

    expect(listedIds()).toContain("conv-bg-custom");
  });

  test("scheduled conversation in system:scheduled stays excluded", () => {
    createConversation({
      id: "conv-sched-system",
      conversationType: "scheduled",
      source: "schedule",
      groupId: "system:scheduled",
    });

    expect(listedIds()).not.toContain("conv-sched-system");
  });

  test("subagent conversation stays hidden even in a custom group", () => {
    createConversation({
      id: "conv-subagent-custom",
      conversationType: "background",
      source: "subagent",
      groupId,
    });

    expect(listedIds()).not.toContain("conv-subagent-custom");
  });

  test("private conversation stays hidden even in a custom group", () => {
    // "private" is not a creatable type (legacy rows only, see the
    // conversationTypeClause docstring), so simulate a legacy row directly.
    createConversation({ id: "conv-private-custom", groupId });
    getRawDb().run(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = 'conv-private-custom'",
    );

    expect(listedIds()).not.toContain("conv-private-custom");
  });
});
