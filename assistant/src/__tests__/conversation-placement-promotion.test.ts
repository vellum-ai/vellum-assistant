/**
 * Filing a background or scheduled conversation into a section the user reads
 * promotes it durably.
 *
 * Placement into Pinned or a custom group stamps `surfaced_at`, so the
 * promotion outlives the placement that caused it: taking the conversation
 * back out returns it to Recents rather than hiding it. Demotion is the
 * mirror image, and filing into `system:background` / `system:scheduled`
 * clears the stamp.
 *
 * The cases below pin both edges. Under-promoting hides a conversation the
 * user deliberately filed somewhere; over-promoting drags hidden automation
 * into the sidebar, so the "what promotion must not do" block is as
 * load-bearing as the rest.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  batchSetConversationPlacement,
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

    batchSetConversationPlacement([{ id: conv.id, groupId: "system:pinned" }]);

    expect(titlesInGroup("system:pinned")).toEqual(["bg-job"]);
  });

  test("unpinning lands it in Recents rather than hiding it again", () => {
    const conv = seedRoutedBackground("bg-job", "background");
    batchSetConversationPlacement([{ id: conv.id, groupId: "system:pinned" }]);

    batchSetConversationPlacement([{ id: conv.id, groupId: "system:all" }]);

    expect(titlesInGroup("system:all")).toEqual(["bg-job"]);
  });
});

describe("filing a background conversation into a custom group", () => {
  test("shows it in that group", () => {
    const group = createGroup("Car Chat");
    const conv = seedRoutedBackground("bg-job", "background");

    batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    expect(titlesInGroup(group.id)).toEqual(["bg-job"]);
  });

  test("removing it from the group lands it in Recents rather than losing it", () => {
    const group = createGroup("Car Chat");
    const conv = seedRoutedBackground("bg-job", "background");
    batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    batchSetConversationPlacement([{ id: conv.id, groupId: "system:all" }]);

    expect(titlesInGroup("system:all")).toEqual(["bg-job"]);
    expect(visibleTitles()).toEqual(["bg-job"]);
  });

  test("applies to scheduled conversations too", () => {
    const group = createGroup("Morning Briefs");
    const conv = seedRoutedBackground("sched-job", "scheduled");

    batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);
    batchSetConversationPlacement([{ id: conv.id, groupId: "system:all" }]);

    expect(titlesInGroup("system:all")).toEqual(["sched-job"]);
  });
});

describe("what promotion must not do", () => {
  test("filing into system:background still demotes", () => {
    const conv = seedRoutedBackground("bg-job", "background");
    // Promote first, so the demotion has something to undo.
    batchSetConversationPlacement([{ id: conv.id, groupId: "system:pinned" }]);
    expect(titlesInGroup("system:pinned")).toEqual(["bg-job"]);

    batchSetConversationPlacement([
      { id: conv.id, groupId: "system:background" },
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

    batchSetConversationPlacement([{ id: conv.id, groupId: "system:all" }]);

    expect(visibleTitles()).toEqual([]);
  });

  test("unpinning through the legacy isPinned path still lands in Recents", () => {
    // Old clients send `isPinned: false` with no `groupId`, and that branch
    // restores the row's original system bucket to keep its provenance. It
    // deliberately does not clear the promotion: unpinning is not a demotion,
    // so the conversation belongs in Recents afterwards, the same as the
    // modern path that sends `groupId: "system:all"`.
    //
    // The row therefore sits in `system:background` while remaining visible.
    // That is the intended split: the bucket records where the conversation
    // came from, `surfaced_at` records that the user promoted it, and only
    // an explicit demotion clears the latter.
    const conv = seedRoutedBackground("bg-job", "background");
    batchSetConversationPlacement([{ id: conv.id, groupId: "system:pinned" }]);

    batchSetConversationPlacement([{ id: conv.id, isPinned: false }]);

    expect(visibleTitles()).toEqual(["bg-job"]);
    expect(titlesInGroup("system:all")).toEqual(["bg-job"]);
  });

  test("standard conversations are not stamped as surfaced", () => {
    // They are already visible, so stamping them would leave `surfaced_at`
    // meaning nothing.
    const group = createGroup("Car Chat");
    const conv = createConversation("plain-chat");

    batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    const row = getDb()
      .all(`SELECT surfaced_at FROM conversations WHERE id = '${conv.id}'`)
      .at(0) as { surfaced_at: number | null };
    expect(row.surfaced_at).toBeNull();
  });
});
