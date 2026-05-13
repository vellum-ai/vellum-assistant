import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createConversation } from "../conversation-crud.js";
import { countConversations } from "../conversation-queries.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
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
});
