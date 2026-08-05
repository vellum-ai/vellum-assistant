/**
 * Filing a background or scheduled conversation into a section the user reads
 * promotes it durably.
 *
 * Sidebar visibility for these rows used to depend on where the conversation
 * currently sat rather than on any record that it had been promoted, so the
 * same deliberate action produced two different outcomes: filing one into a
 * custom group showed it, then removing it from that group made it vanish
 * rather than fall back to Recents, and pinning never showed it at all
 * because `system:pinned` fails the custom-group arm's `system:` prefix
 * check. Placement now stamps `surfaced_at`, so promotion survives the next
 * move.
 *
 * Demotion is the mirror image and already worked: filing into
 * `system:background` / `system:scheduled` clears the promotion.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  batchSetDisplayOrders,
  createConversation,
} from "../persistence/conversation-crud.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createGroup } from "../persistence/group-crud.js";
import { rawRun } from "../persistence/raw-query.js";
import { conversations } from "../persistence/schema/index.js";

await initializeDb();

function seedRoutedBackground(title: string, type: "background" | "scheduled") {
  const conv = createConversation({ title, conversationType: type });
  rawRun(
    "test:routeToSystemBucket",
    "UPDATE conversations SET group_id = ? WHERE id = ?",
    type === "scheduled" ? "system:scheduled" : "system:background",
    conv.id,
  );
  return conv;
}

/** Titles the sidebar's standard listing would render. */
function visibleTitles(): string[] {
  return listConversations({ limit: 100 }).map((c) => c.title ?? "");
}

function titlesInGroup(groupId: string): string[] {
  return listConversations({ limit: 100, groupId }).map((c) => c.title ?? "");
}

beforeEach(() => {
  getDb().delete(conversations).run();
});

describe("pinning a background conversation", () => {
  test("shows it in Pinned", () => {
    const conv = seedRoutedBackground("bg-job", "background");
    expect(visibleTitles()).toEqual([]);

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: "system:pinned" },
    ]);

    expect(titlesInGroup("system:pinned")).toEqual(["bg-job"]);
  });

  test("unpinning lands it in Recents rather than hiding it again", () => {
    const conv = seedRoutedBackground("bg-job", "background");
    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: "system:pinned" },
    ]);

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: null, groupId: "system:all" },
    ]);

    expect(titlesInGroup("system:all")).toEqual(["bg-job"]);
  });
});

describe("filing a background conversation into a custom group", () => {
  test("shows it in that group", () => {
    const group = createGroup("Car Chat");
    const conv = seedRoutedBackground("bg-job", "background");

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: group.id },
    ]);

    expect(titlesInGroup(group.id)).toEqual(["bg-job"]);
  });

  test("removing it from the group lands it in Recents rather than losing it", () => {
    const group = createGroup("Car Chat");
    const conv = seedRoutedBackground("bg-job", "background");
    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: group.id },
    ]);

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: null, groupId: "system:all" },
    ]);

    expect(titlesInGroup("system:all")).toEqual(["bg-job"]);
    expect(visibleTitles()).toEqual(["bg-job"]);
  });

  test("applies to scheduled conversations too", () => {
    const group = createGroup("Morning Briefs");
    const conv = seedRoutedBackground("sched-job", "scheduled");

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: group.id },
    ]);
    batchSetDisplayOrders([
      { id: conv.id, displayOrder: null, groupId: "system:all" },
    ]);

    expect(titlesInGroup("system:all")).toEqual(["sched-job"]);
  });
});

describe("what promotion must not do", () => {
  test("filing into system:background still demotes", () => {
    const conv = seedRoutedBackground("bg-job", "background");
    // Promote first, so the demotion has something to undo.
    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: "system:pinned" },
    ]);
    expect(titlesInGroup("system:pinned")).toEqual(["bg-job"]);

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: null, groupId: "system:background" },
    ]);

    expect(visibleTitles()).toEqual([]);
  });

  test("a background conversation nobody placed anywhere stays hidden", () => {
    seedRoutedBackground("untouched", "background");

    expect(visibleTitles()).toEqual([]);
  });

  test("moving to system:all does not by itself promote", () => {
    // Removal is not a promotion: a row that was never filed into a section
    // the user reads must not become visible just by being moved out of its
    // system bucket.
    const conv = seedRoutedBackground("bg-job", "background");

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: null, groupId: "system:all" },
    ]);

    expect(visibleTitles()).toEqual([]);
  });

  test("standard conversations are not stamped as surfaced", () => {
    // They are already visible, so stamping them would leave `surfaced_at`
    // meaning nothing.
    const group = createGroup("Car Chat");
    const conv = createConversation("plain-chat");

    batchSetDisplayOrders([
      { id: conv.id, displayOrder: 0, groupId: group.id },
    ]);

    const row = getDb()
      .all(`SELECT surfaced_at FROM conversations WHERE id = '${conv.id}'`)
      .at(0) as { surfaced_at: number | null };
    expect(row.surfaced_at).toBeNull();
  });
});
