import { describe, expect, test } from "bun:test";

import {
  mergeSectionOrder,
  moveSectionKey,
  nextStoredOrder,
} from "@/domains/chat/utils/sidebar-section-order";

describe("mergeSectionOrder", () => {
  test("falls back to the default order when nothing is stored", () => {
    const defaults = ["pinned", "grp-a", "recents", "channel:slack"];
    expect(mergeSectionOrder(defaults, [])).toEqual(defaults);
  });

  test("applies the stored order", () => {
    expect(
      mergeSectionOrder(
        ["pinned", "grp-a", "recents", "channel:slack"],
        ["recents", "channel:slack", "pinned", "grp-a"],
      ),
    ).toEqual(["recents", "channel:slack", "pinned", "grp-a"]);
  });

  test("ignores stored keys that no longer name a section", () => {
    // "grp-deleted" was dragged once, then the group was deleted. It must not
    // leave a gap or throw the surrounding order off.
    expect(
      mergeSectionOrder(
        ["recents", "grp-a"],
        ["grp-deleted", "grp-a", "recents"],
      ),
    ).toEqual(["grp-a", "recents"]);
  });

  test("slots an unknown section after its default-order predecessor", () => {
    // The user has dragged Chats above their group; a *new* group is then
    // created. Its default position is beside the existing group, and that's
    // where it should land - not swept to either end.
    expect(
      mergeSectionOrder(
        ["grp-a", "grp-new", "recents"],
        ["recents", "grp-a"],
      ),
    ).toEqual(["recents", "grp-a", "grp-new"]);
  });

  test("an unknown section ahead of every stored key sorts to the top", () => {
    expect(
      mergeSectionOrder(["pinned", "recents", "grp-a"], ["recents", "grp-a"]),
    ).toEqual(["pinned", "recents", "grp-a"]);
  });

  test("keeps consecutive unknown sections in default order", () => {
    expect(
      mergeSectionOrder(
        ["recents", "channel:slack", "channel:telegram"],
        ["recents"],
      ),
    ).toEqual(["recents", "channel:slack", "channel:telegram"]);
  });

  test("survives a duplicated stored key", () => {
    expect(
      mergeSectionOrder(["recents", "grp-a"], ["grp-a", "recents", "grp-a"]),
    ).toEqual(["grp-a", "recents"]);
  });
});

describe("nextStoredOrder", () => {
  test("stores the live order verbatim when nothing was preserved", () => {
    expect(nextStoredOrder([], ["recents", "grp-a"])).toEqual([
      "recents",
      "grp-a",
    ]);
  });

  test("keeps the slot of a channel section that has gone quiet", () => {
    // Telegram had no conversations at drag time, so it isn't in `liveOrder`.
    // Its stored slot (right after Chats) has to survive, or it reappears at
    // whatever position the default order gives it.
    expect(
      nextStoredOrder(
        ["grp-a", "recents", "channel:telegram", "channel:slack"],
        ["grp-a", "recents", "channel:slack"],
      ),
    ).toEqual(["grp-a", "recents", "channel:telegram", "channel:slack"]);
  });

  test("keeps an empty Pinned section's slot", () => {
    // Pinned led the stored order and has no surviving predecessor to trail,
    // so it goes back to the front - where it was.
    expect(
      nextStoredOrder(["pinned", "grp-a", "recents"], ["recents", "grp-a"]),
    ).toEqual(["pinned", "recents", "grp-a"]);
  });

  // A key can be absent because the section was deleted, because it is empty,
  // or because the groups query has not resolved yet. Those are
  // indistinguishable here, so absence never prunes: a reorder performed
  // before groups load must not wipe out the user's stored group positions.
  test("keeps a group's slot when the groups query has not resolved", () => {
    expect(
      nextStoredOrder(
        ["grp-a", "recents", "channel:slack"],
        ["recents", "channel:slack"],
      ),
    ).toEqual(["grp-a", "recents", "channel:slack"]);
  });

  test("a stale key survives but stays inert on read", () => {
    const stored = nextStoredOrder(["grp-gone", "recents"], ["recents"]);
    expect(stored).toEqual(["grp-gone", "recents"]);
    // mergeSectionOrder only ever returns keys naming a live section.
    expect(mergeSectionOrder(["recents"], stored)).toEqual(["recents"]);
  });

  test("trims absent keys once the list outgrows its cap", () => {
    const stale = Array.from({ length: 120 }, (_, i) => `grp-old-${i}`);
    const result = nextStoredOrder([...stale, "recents"], ["recents"]);
    expect(result.length).toBe(100);
    // The live section keeps its slot regardless of how much is trimmed.
    expect(result).toContain("recents");
  });

  test("keeps a run of absent conditional keys in their stored order", () => {
    expect(
      nextStoredOrder(
        ["recents", "channel:slack", "channel:telegram", "grp-a"],
        ["recents", "grp-a"],
      ),
    ).toEqual(["recents", "channel:slack", "channel:telegram", "grp-a"]);
  });
});

describe("moveSectionKey", () => {
  test("moves a key up", () => {
    expect(moveSectionKey(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  });

  test("moves a key down", () => {
    expect(moveSectionKey(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  test("returns null at either end", () => {
    expect(moveSectionKey(["a", "b"], "a", -1)).toBeNull();
    expect(moveSectionKey(["a", "b"], "b", 1)).toBeNull();
  });

  test("returns null for a key that isn't in the list", () => {
    expect(moveSectionKey(["a", "b"], "z", 1)).toBeNull();
  });
});
