import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigration } from "../persistence/conversation-group-migration.js";
import {
  listConversations,
  listPinnedConversations,
} from "../persistence/conversation-queries.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createGroup } from "../persistence/group-crud.js";

await initializeDb();
ensureGroupMigration();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * Every conversation list orders by recency, pinned and custom groups
 * included.
 *
 * `display_order` is a live column and some rows carry a value in it, so
 * "nothing writes it" is not enough to make the order consistent: a read that
 * consulted it would serve those rows in an arrangement no user can change,
 * while every other surface shows recency.
 *
 * Each test sets `display_order` to contradict recency, so a read that
 * consults it fails here rather than passing by coincidence.
 */
describe("conversation list ordering ignores display_order", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM conversations");
    raw.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
  });

  /** Give a row a `display_order` and a recency stamp that disagree. */
  function arrange(id: string, displayOrder: number, lastMessageAt: number) {
    getRawDb().run(
      "UPDATE conversations SET display_order = ?, last_message_at = ? WHERE id = ?",
      [displayOrder, lastMessageAt, id],
    );
  }

  test("a custom group orders by recency, ignoring display_order", () => {
    const groupId = createGroup("Briefs").id;
    createConversation({ id: "conv-old", source: "user", groupId });
    createConversation({ id: "conv-new", source: "user", groupId });
    // `display_order` says old-then-new; recency says the opposite.
    arrange("conv-old", 0, 1_000);
    arrange("conv-new", 1, 9_000);

    expect(listConversations({ groupId }).map((c) => c.id)).toEqual([
      "conv-new",
      "conv-old",
    ]);
  });

  test("the pinned group orders by recency, ignoring display_order", () => {
    createConversation({
      id: "pin-old",
      source: "user",
      groupId: "system:pinned",
    });
    createConversation({
      id: "pin-new",
      source: "user",
      groupId: "system:pinned",
    });
    arrange("pin-old", 0, 1_000);
    arrange("pin-new", 1, 9_000);

    expect(
      listConversations({ groupId: "system:pinned" }).map((c) => c.id),
    ).toEqual(["pin-new", "pin-old"]);
  });

  /* The page-one pinned injection reads through its own query, so it needs
     the same guarantee: one section must not have two orderings depending on
     which read served it. */
  test("listPinnedConversations orders by recency too", () => {
    createConversation({
      id: "pin-old",
      source: "user",
      groupId: "system:pinned",
    });
    createConversation({
      id: "pin-new",
      source: "user",
      groupId: "system:pinned",
    });
    getRawDb().run("UPDATE conversations SET is_pinned = 1");
    arrange("pin-old", 0, 1_000);
    arrange("pin-new", 1, 9_000);

    expect(listPinnedConversations().map((c) => c.id)).toEqual([
      "pin-new",
      "pin-old",
    ]);
  });
});
