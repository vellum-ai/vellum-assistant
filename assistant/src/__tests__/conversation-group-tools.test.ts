import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  createConversation,
  getDisplayMetaForConversations,
} from "../persistence/conversation-crud.js";
import { ensureGroupMigration } from "../persistence/conversation-group-migration.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { executeConversationGroupCreate } from "../tools/conversation-groups/group_create.js";
import { executeConversationGroupList } from "../tools/conversation-groups/group_list.js";
import { executeConversationMoveToGroup } from "../tools/conversation-groups/move_to_group.js";
import type { ToolContext } from "../tools/types.js";

await initializeDb();
ensureGroupMigration();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function clearState(): void {
  const raw = getRawDb();
  raw.run("DELETE FROM conversations");
  raw.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
}

function extractGroupId(content: string): string {
  const match = content.match(/id: ([0-9a-f-]{36})/);
  expect(match).not.toBeNull();
  return match![1];
}

function groupIdOf(conversationId: string): string | null {
  return (
    getDisplayMetaForConversations([conversationId]).get(conversationId)
      ?.groupId ?? null
  );
}

// ── conversation_group_list ─────────────────────────────────────────

describe("conversation_group_list tool", () => {
  beforeEach(clearState);

  test("lists system groups", async () => {
    const result = await executeConversationGroupList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Pinned (id: system:pinned)");
    expect(result.content).toContain("Recents (id: system:all)");
    expect(result.content).toContain("[system group]");
  });

  test("lists custom groups after creation", async () => {
    await executeConversationGroupCreate({ name: "Work" }, ctx);

    const result = await executeConversationGroupList({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Work");
  });
});

// ── conversation_group_create ───────────────────────────────────────

describe("conversation_group_create tool", () => {
  beforeEach(clearState);

  test("creates a custom group", async () => {
    const result = await executeConversationGroupCreate(
      { name: "Travel planning" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Created group "Travel planning"');
  });

  test("trims the name", async () => {
    const result = await executeConversationGroupCreate(
      { name: "  Padded  " },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Created group "Padded"');
  });

  test("reuses an existing group with the same name (case-insensitive)", async () => {
    const first = await executeConversationGroupCreate({ name: "Work" }, ctx);
    const firstId = extractGroupId(first.content);

    const second = await executeConversationGroupCreate({ name: "work" }, ctx);
    expect(second.isError).toBe(false);
    expect(second.content).toContain("already exists");
    expect(second.content).toContain(firstId);
  });

  test("rejects system group names", async () => {
    const result = await executeConversationGroupCreate(
      { name: "pinned" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("system group");
  });

  test("rejects missing name", async () => {
    const result = await executeConversationGroupCreate({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("name is required");
  });
});

// ── conversation_move_to_group ──────────────────────────────────────

describe("conversation_move_to_group tool", () => {
  beforeEach(clearState);

  test("moves a conversation into a custom group by name", async () => {
    createConversation({ id: "conv-1", title: "Trip ideas" });
    await executeConversationGroupCreate({ name: "Travel" }, ctx);

    const result = await executeConversationMoveToGroup(
      { group: "travel", conversation_id: "conv-1" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Moved "Trip ideas" to group "Travel"');
    expect(groupIdOf("conv-1")).not.toBe("system:all");
  });

  test("moves a conversation by group id", async () => {
    createConversation({ id: "conv-2" });
    const created = await executeConversationGroupCreate({ name: "Work" }, ctx);
    const groupId = extractGroupId(created.content);

    const result = await executeConversationMoveToGroup(
      { group: groupId, conversation_id: "conv-2" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(groupIdOf("conv-2")).toBe(groupId);
  });

  test("defaults to the current conversation", async () => {
    createConversation({ id: "test-conversation", title: "This chat" });
    await executeConversationGroupCreate({ name: "Inbox" }, ctx);

    const result = await executeConversationMoveToGroup(
      { group: "Inbox" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Moved "This chat" to group "Inbox"');
  });

  test("moving to Pinned pins the conversation", async () => {
    createConversation({ id: "conv-pin" });

    const result = await executeConversationMoveToGroup(
      { group: "Pinned", conversation_id: "conv-pin" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("pinned");
    expect(groupIdOf("conv-pin")).toBe("system:pinned");
    const pinned = getRawDb()
      .query("SELECT is_pinned FROM conversations WHERE id = ?")
      .get("conv-pin") as { is_pinned: number };
    expect(pinned.is_pinned).toBe(1);
  });

  test("preserves display_order across a move", async () => {
    createConversation({ id: "conv-ord" });
    getRawDb().run(
      "UPDATE conversations SET display_order = 7 WHERE id = 'conv-ord'",
    );
    await executeConversationGroupCreate({ name: "Ordered" }, ctx);

    const result = await executeConversationMoveToGroup(
      { group: "Ordered", conversation_id: "conv-ord" },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT display_order FROM conversations WHERE id = ?")
      .get("conv-ord") as { display_order: number | null };
    expect(row.display_order).toBe(7);
  });

  test("no-op when already in the target group", async () => {
    createConversation({ id: "conv-3", title: "Settled" });

    const result = await executeConversationMoveToGroup(
      { group: "Recents", conversation_id: "conv-3" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("already in group");
  });

  test("errors on unknown group with available list", async () => {
    createConversation({ id: "conv-4" });

    const result = await executeConversationMoveToGroup(
      { group: "Nonexistent", conversation_id: "conv-4" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No group named "Nonexistent"');
    expect(result.content).toContain("Available groups:");
  });

  test("errors on ambiguous group name", async () => {
    // Two custom groups whose names differ only by case
    await executeConversationGroupCreate({ name: "Alpha" }, ctx);
    // Bypass the tool's dedup to create the case-variant directly
    getRawDb().run(
      "INSERT INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at) VALUES ('dup-group-id', 'alpha', 99, 0, 0, 0)",
    );
    createConversation({ id: "conv-5" });

    const result = await executeConversationMoveToGroup(
      { group: "ALPHA", conversation_id: "conv-5" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ambiguous");
    expect(result.content).toContain("Retry with the group id");
  });

  test("errors on unknown conversation", async () => {
    const result = await executeConversationMoveToGroup(
      { group: "Recents", conversation_id: "missing-conv" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no conversation found");
  });

  test("tells the model a custom group surfaces a hidden conversation", async () => {
    createConversation({ id: "conv-bg", conversationType: "background" });
    await executeConversationGroupCreate({ name: "Visible" }, ctx);

    const result = await executeConversationMoveToGroup(
      { group: "Visible", conversation_id: "conv-bg" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("surfaces it into the sidebar");
  });

  test("does not claim a move to Recents surfaces a hidden conversation", async () => {
    // Recents is a removal target, not a promotion: the write path leaves an
    // unpromoted background row hidden there, so saying otherwise would report
    // an outcome to the model that did not happen.
    createConversation({ id: "conv-bg-all", conversationType: "background" });

    const result = await executeConversationMoveToGroup(
      { group: "system:all", conversation_id: "conv-bg-all" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("surfaces it into the sidebar");
  });

  test("does not claim a move to Background surfaces a hidden conversation", async () => {
    createConversation({
      id: "conv-bg-demote",
      conversationType: "background",
    });

    const result = await executeConversationMoveToGroup(
      { group: "system:background", conversation_id: "conv-bg-demote" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("surfaces it into the sidebar");
  });

  test("rejects missing group", async () => {
    const result = await executeConversationMoveToGroup({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("group is required");
  });
});
