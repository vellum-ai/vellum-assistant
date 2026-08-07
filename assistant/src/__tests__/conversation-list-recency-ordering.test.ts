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
 * Every list orders by recency, including the groups that once honored a
 * manual arrangement.
 *
 * `display_order` is still a column and still carries values for anyone who
 * drag-reordered before that affordance was removed, so "nothing writes it"
 * is not enough to make the order consistent: a read that consults it would
 * serve those users a manual arrangement they can no longer change, while
 * every other surface shows recency.
 *
 * Each test sets `display_order` to contradict recency, so a read that
 * consults it again fails here rather than passing by coincidence.
 */
describe("conversation list ordering ignores display_order", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM conversations");
    raw.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
  });

  /** Give a row an explicit manual slot and a recency stamp that disagrees. */
  function arrange(id: string, displayOrder: number, lastMessageAt: number) {
    getRawDb().run(
      "UPDATE conversations SET display_order = ?, last_message_at = ? WHERE id = ?",
      [displayOrder, lastMessageAt, id],
    );
  }

  test("a custom group orders by recency, not by the stored arrangement", () => {
    const groupId = createGroup("Briefs").id;
    createConversation({ id: "conv-old", source: "user", groupId });
    createConversation({ id: "conv-new", source: "user", groupId });
    // The arrangement says old-then-new; recency says the opposite.
    arrange("conv-old", 0, 1_000);
    arrange("conv-new", 1, 9_000);

    expect(listConversations({ groupId }).map((c) => c.id)).toEqual([
      "conv-new",
      "conv-old",
    ]);
  });

  test("the pinned group orders by recency, not by the stored arrangement", () => {
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
     the same guarantee: two orderings for the same section is the state this
     removal exists to end. */
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
