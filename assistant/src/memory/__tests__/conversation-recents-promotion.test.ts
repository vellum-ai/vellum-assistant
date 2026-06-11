import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConversation,
  promoteConversationToRecentsIfNeeded,
} from "../conversation-crud.js";
import { ensureGroupMigration } from "../conversation-group-migration.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { createGroup } from "../group-crud.js";
import { rawGet, rawRun } from "../raw-query.js";

initializeDb();

function resetTables(): void {
  ensureGroupMigration();
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
  db.run(`DELETE FROM conversation_groups WHERE is_system_group = 0`);
}

function readConversationDisplay(id: string): {
  conversation_type: string;
  source: string | null;
  schedule_job_id: string | null;
  group_id: string | null;
  is_pinned: number | null;
  display_order: number | null;
} {
  const row = rawGet<{
    conversation_type: string;
    source: string | null;
    schedule_job_id: string | null;
    group_id: string | null;
    is_pinned: number | null;
    display_order: number | null;
  }>(
    `SELECT conversation_type, source, schedule_job_id, group_id, is_pinned, display_order
       FROM conversations
      WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`missing conversation ${id}`);
  return row;
}

describe("promoteConversationToRecentsIfNeeded", () => {
  beforeEach(() => {
    resetTables();
  });

  test("moves scheduled display rows to Recents while preserving provenance", () => {
    const conversation = createConversation({
      title: "scheduled run",
      conversationType: "scheduled",
      source: "schedule",
      scheduleJobId: "job-123",
      groupId: "system:scheduled",
    });
    rawRun(
      "UPDATE conversations SET display_order = ?, is_pinned = 1 WHERE id = ?",
      42,
      conversation.id,
    );

    const moved = promoteConversationToRecentsIfNeeded(conversation.id);

    expect(moved).toBe(true);
    expect(readConversationDisplay(conversation.id)).toEqual({
      conversation_type: "scheduled",
      source: "schedule",
      schedule_job_id: "job-123",
      group_id: "system:all",
      is_pinned: 0,
      display_order: null,
    });
  });

  test("moves background display rows to Recents", () => {
    const conversation = createConversation({
      title: "heartbeat run",
      conversationType: "background",
      source: "heartbeat",
      groupId: "system:background",
    });

    const moved = promoteConversationToRecentsIfNeeded(conversation.id);

    expect(moved).toBe(true);
    expect(readConversationDisplay(conversation.id).group_id).toBe("system:all");
  });

  test("does not write rows that are already displayed in Recents", () => {
    const conversation = createConversation({
      title: "already recent",
      conversationType: "scheduled",
      source: "schedule",
      groupId: "system:all",
    });

    const moved = promoteConversationToRecentsIfNeeded(conversation.id);

    expect(moved).toBe(false);
    expect(readConversationDisplay(conversation.id).group_id).toBe("system:all");
  });

  test("does not move pinned or custom grouped conversations", () => {
    const pinned = createConversation({
      title: "pinned run",
      conversationType: "scheduled",
      groupId: "system:pinned",
    });
    const group = createGroup("Runs");
    const custom = createConversation({
      title: "custom run",
      conversationType: "background",
      groupId: group.id,
    });

    expect(promoteConversationToRecentsIfNeeded(pinned.id)).toBe(false);
    expect(promoteConversationToRecentsIfNeeded(custom.id)).toBe(false);
    expect(readConversationDisplay(pinned.id).group_id).toBe("system:pinned");
    expect(readConversationDisplay(custom.id).group_id).toBe(group.id);
  });
});
