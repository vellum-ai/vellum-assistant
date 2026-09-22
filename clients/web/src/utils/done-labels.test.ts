/**
 * The archive/done label set.
 *
 * One test per side of the flag, because the whole point of the module is
 * that a surface never chooses a key: if a field forgot to branch, the two
 * sets would agree where they must differ.
 */

import { describe, expect, test } from "bun:test";
import { Archive, ArchiveRestore, Check, RotateCcw } from "lucide-react";

import { fixedT } from "@/i18n";
import { conversationDoneLabels } from "@/utils/done-labels";

const t = fixedT("chat");

describe("conversationDoneLabels", () => {
  test("flag off is today's archive wording", () => {
    const labels = conversationDoneLabels(t, false);
    expect(labels.archive).toBe("Archive");
    expect(labels.unarchive).toBe("Unarchive");
    expect(labels.swipeArchive).toBe("Archive");
    expect(labels.archiveAll).toBe("Archive All…");
    expect(labels.archiveAllTitle).toBe("Archive All");
    expect(labels.archiveAllConfirm).toBe("Archive All");
    expect(labels.headerBadge).toBe("[Archived]");
  });

  test("flag on reads as completion", () => {
    const labels = conversationDoneLabels(t, true);
    expect(labels.archive).toBe("Mark as done");
    expect(labels.unarchive).toBe("Reopen");
    expect(labels.swipeArchive).toBe("Done");
    expect(labels.archiveAll).toBe("Mark all as done…");
    expect(labels.archiveAllTitle).toBe("Mark all as done");
    expect(labels.archiveAllConfirm).toBe("Mark all as done");
    expect(labels.headerBadge).toBe("[Done]");
  });

  test("every field differs between the two sets", () => {
    const off = conversationDoneLabels(t, false);
    const on = conversationDoneLabels(t, true);
    for (const key of [
      "archive",
      "unarchive",
      "swipeArchive",
      "archiveAll",
      "archiveAllTitle",
      "archiveAllConfirm",
      "headerBadge",
    ] as const) {
      expect(off[key]).not.toBe(on[key]);
    }
  });

  /* A menu row reading "Mark as done" beside an archive box is the drift the
     icons travel with the labels to prevent. */
  test("the glyphs change with the wording", () => {
    const off = conversationDoneLabels(t, false);
    expect(off.archiveIcon).toBe(Archive);
    expect(off.unarchiveIcon).toBe(ArchiveRestore);
    expect(off.archiveAllIcon).toBe(Archive);

    const on = conversationDoneLabels(t, true);
    expect(on.archiveIcon).toBe(Check);
    expect(on.unarchiveIcon).toBe(RotateCcw);
    expect(on.archiveAllIcon).toBe(Check);
  });

  test("the bulk confirmation stops telling users to search is:archived", () => {
    const vars = { count: 3, groupName: "PR Reviews" };
    const off = conversationDoneLabels(t, false).archiveAllMessage(vars);
    const on = conversationDoneLabels(t, true).archiveAllMessage(vars);

    expect(off).toContain("is:archived");
    expect(on).not.toContain("is:archived");
    // Both still name the section and the count they act on.
    for (const message of [off, on]) {
      expect(message).toContain("PR Reviews");
      expect(message).toContain("3");
    }
  });
});
