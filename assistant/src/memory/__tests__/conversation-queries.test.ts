import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createConversation } from "../conversation-crud.js";
import {
  countConversations,
  listConversations,
} from "../conversation-queries.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { rawRun } from "../raw-query.js";
import { conversations } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

function setConversationType(conversationId: string, type: string): void {
  const db = getDb();
  db.update(conversations)
    .set({ conversationType: type })
    .where(eq(conversations.id, conversationId))
    .run();
}

describe("countConversations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("excludes 'private', 'background', and 'scheduled' rows from the foreground count", () => {
    createConversation("foreground-1");
    createConversation("foreground-2");

    const priv = createConversation("private-1");
    setConversationType(priv.id, "private");

    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    expect(countConversations()).toBe(2);
  });

  test("background-only count excludes private rows", () => {
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    const priv = createConversation("private-1");
    setConversationType(priv.id, "private");

    expect(countConversations(true)).toBe(2);
  });

  test("includes standard conversations with group_id system:background in background count", () => {
    // GIVEN a standard conversation routed to system:background (e.g. heartbeat)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a regular foreground conversation
    createConversation("foreground-1");

    // WHEN counting background conversations
    const bgCount = countConversations(true);

    // THEN the heartbeat conversation is included
    expect(bgCount).toBe(1);

    // AND excluded from the foreground count
    expect(countConversations(false)).toBe(1);
  });

  test("excludes standard conversations with group_id system:background from foreground count", () => {
    // GIVEN two foreground conversations and one heartbeat
    createConversation("foreground-1");
    createConversation("foreground-2");
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // WHEN counting foreground conversations
    // THEN the heartbeat is excluded
    expect(countConversations(false)).toBe(2);
  });
});

describe("listConversations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("background fetch includes conversations with group_id system:background regardless of conversationType", () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a real background conversation
    createConversation({ title: "bg-1", conversationType: "background" });

    // AND a foreground conversation
    createConversation("foreground-1");

    // WHEN listing background conversations
    const bgList = listConversations(100, true);

    // THEN both background and heartbeat conversations are returned
    expect(bgList).toHaveLength(2);
    const titles = bgList.map((c) => c.title);
    expect(titles).toContain("heartbeat-1");
    expect(titles).toContain("bg-1");
  });

  test("foreground fetch excludes conversations with group_id system:background", () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a foreground conversation
    createConversation("foreground-1");

    // WHEN listing foreground conversations
    const fgList = listConversations(100, false);

    // THEN only the foreground conversation is returned
    expect(fgList).toHaveLength(1);
    expect(fgList[0]!.title).toBe("foreground-1");
  });

  test("conversations with group_id system:scheduled are included in background fetch", () => {
    // GIVEN a conversation with group_id system:scheduled but conversationType standard
    const conv = createConversation("schedule-routed");
    rawRun(
      "UPDATE conversations SET group_id = 'system:scheduled' WHERE id = ?",
      conv.id,
    );

    // WHEN listing background conversations
    const bgList = listConversations(100, true);

    // THEN it appears in the background list
    expect(bgList).toHaveLength(1);
    expect(bgList[0]!.title).toBe("schedule-routed");

    // AND not in the foreground list
    const fgList = listConversations(100, false);
    expect(fgList).toHaveLength(0);
  });
});
