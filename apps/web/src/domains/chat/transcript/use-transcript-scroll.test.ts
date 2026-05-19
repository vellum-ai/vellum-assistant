/**
 * Tests for the transcript scroll coordinator.
 *
 * This project's test runner (bun:test) has no DOM environment and no
 * @testing-library/react, so we cannot render the hook directly. Instead
 * we split the coordinator into pure helpers (`classifyScrollPosition`,
 * `findAnchorIndex`, `decideItemsChangeAction`) that own every
 * load-bearing decision. The hook itself is a thin wiring layer on top of
 * those helpers — each test below maps directly to one of the
 * acceptance-criteria behaviors in the PR plan.
 *
 * In column-reverse layout, scrollTop = 0 is the visual bottom (latest
 * messages). Scrolling UP increases scrollTop. So:
 *   - distanceFromBottom = scrollTop
 *   - distanceFromTop = scrollHeight - clientHeight - scrollTop
 */

import { describe, expect, mock, test } from "bun:test";

import type { TranscriptItem } from "@/domains/chat/lib/transcript/types.js";
import {
  classifyScrollPosition,
  decideItemsChangeAction,
  findAnchorIndex,
  PINNED_THRESHOLD_PX,
  SHOW_SCROLL_BUTTON_THRESHOLD_PX,
  type TranscriptHandle,
} from "@/domains/chat/transcript/use-transcript-scroll.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(stableId: string): TranscriptItem {
  // Build a minimal MessageItem. The hook never inspects `message` fields;
  // only `key`/`kind` identity matters for the scroll coordinator.
  return {
    kind: "message",
    key: stableId,
    message: {
      stableId,
      role: "assistant",
      content: "",
    },
  };
}

function items(ids: readonly string[]): TranscriptItem[] {
  return ids.map(makeMessage);
}

function makeHandle(): TranscriptHandle & {
  calls: {
    scrollToLatest: Array<[{ behavior?: "auto" | "smooth" }?]>;
    getScrollElement: number;
    getViewportHeight: number;
  };
} {
  const calls = {
    scrollToLatest: [] as Array<[{ behavior?: "auto" | "smooth" }?]>,
    getScrollElement: 0,
    getViewportHeight: 0,
  };
  const scrollToLatest = mock((opts?: { behavior?: "auto" | "smooth" }) => {
    calls.scrollToLatest.push([opts]);
  });
  const getScrollElement = mock((): HTMLDivElement | null => {
    calls.getScrollElement += 1;
    return null;
  });
  const getViewportHeight = mock((): number => {
    calls.getViewportHeight += 1;
    return 800;
  });
  return {
    scrollToLatest,
    getScrollElement,
    getViewportHeight,
    calls,
  };
}

// ---------------------------------------------------------------------------
// classifyScrollPosition — column-reverse thresholds
//
// In column-reverse: scrollTop = 0 is the bottom (latest).
// distanceFromBottom = scrollTop
// distanceFromTop = scrollHeight - clientHeight - scrollTop
// ---------------------------------------------------------------------------

describe("classifyScrollPosition — pinned threshold (64 px)", () => {
  test("at the bottom (scrollTop = 0) is pinned", () => {
    const c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(0);
    expect(c.isPinned).toBe(true);
  });

  test("distance exactly 64 is pinned (<=)", () => {
    const c = classifyScrollPosition(
      { scrollTop: 64, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(PINNED_THRESHOLD_PX);
    expect(c.isPinned).toBe(true);
  });

  test("distance 65 is NOT pinned", () => {
    const c = classifyScrollPosition(
      { scrollTop: 65, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(65);
    expect(c.isPinned).toBe(false);
  });
});

describe("classifyScrollPosition — show-scroll-button threshold (240 px)", () => {
  test("distance 240 does NOT show the button (>)", () => {
    const c = classifyScrollPosition(
      { scrollTop: 240, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(SHOW_SCROLL_BUTTON_THRESHOLD_PX);
    expect(c.showScrollToLatest).toBe(false);
  });

  test("distance 241 shows the button", () => {
    const c = classifyScrollPosition(
      { scrollTop: 241, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(241);
    expect(c.showScrollToLatest).toBe(true);
  });

  test("dropping back under 240 hides the button", () => {
    const c = classifyScrollPosition(
      { scrollTop: 239, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(239);
    expect(c.showScrollToLatest).toBe(false);
  });
});

describe("classifyScrollPosition — load-older threshold (200 px)", () => {
  test("scrolled to the top triggers load-older", () => {
    // scrollHeight=5000, clientHeight=800, scrollTop=3800 =>
    // distanceFromTop = 5000 - 800 - 3800 = 400 => NO
    // We want distanceFromTop <= 200, so scrollTop >= 5000 - 800 - 200 = 4000
    const c = classifyScrollPosition(
      { scrollTop: 4000, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(true);
  });

  test("one pixel below threshold does NOT trigger load-older", () => {
    // distanceFromTop = 5000 - 800 - 3999 = 201 => NOT triggered
    const c = classifyScrollPosition(
      { scrollTop: 3999, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when isLoadingOlder is true", () => {
    const c = classifyScrollPosition(
      { scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: true, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when hasMore is false", () => {
    const c = classifyScrollPosition(
      { scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when hasConversation is false", () => {
    const c = classifyScrollPosition(
      { scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: false },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findAnchorIndex
// ---------------------------------------------------------------------------

describe("findAnchorIndex", () => {
  test("returns the index of the matching key", () => {
    const list = items(["a", "b", "c", "d"]);
    expect(findAnchorIndex(list, "c")).toBe(2);
  });

  test("returns -1 when the key is absent", () => {
    const list = items(["a", "b"]);
    expect(findAnchorIndex(list, "z")).toBe(-1);
  });

  test("returns the new index after a prefix is prepended", () => {
    // Older page lands in front of the anchor.
    const before = items(["m1", "m2", "m3"]);
    const after = items(["o1", "o2", "m1", "m2", "m3"]);
    // Saved anchor was "m1" at index 0 before the prepend.
    expect(findAnchorIndex(before, "m1")).toBe(0);
    expect(findAnchorIndex(after, "m1")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// decideItemsChangeAction
// ---------------------------------------------------------------------------

describe("decideItemsChangeAction — no-conversation returns none", () => {
  test("does not act when conversationKey is null", () => {
    const action = decideItemsChangeAction({
      items: items(["m1"]),
      previousItems: [],
      conversationKey: null,
      savedAnchor: null,
      isPinnedToLatest: true,
    });
    expect(action.kind).toBe("none");
  });
});

describe("decideItemsChangeAction — streaming growth", () => {
  test("pinned + items changed -> stick-to-latest", () => {
    const prev = items(["m1", "m2"]);
    const next = items(["m1", "m2", "m3"]);
    const action = decideItemsChangeAction({
      items: next,
      previousItems: prev,
      conversationKey: "conv-1",
      savedAnchor: null,
      isPinnedToLatest: true,
    });
    expect(action).toEqual({ kind: "stick-to-latest" });
  });

  test("NOT pinned + items changed -> none (preserve reader's viewport)", () => {
    const prev = items(["m1", "m2"]);
    const next = items(["m1", "m2", "m3"]);
    const action = decideItemsChangeAction({
      items: next,
      previousItems: prev,
      conversationKey: "conv-1",
      savedAnchor: null,
      isPinnedToLatest: false,
    });
    expect(action.kind).toBe("none");
  });

  test("pinned but no change -> none", () => {
    const list = items(["m1", "m2"]);
    const action = decideItemsChangeAction({
      items: list,
      previousItems: list,
      conversationKey: "conv-1",
      savedAnchor: null,
      isPinnedToLatest: true,
    });
    expect(action.kind).toBe("none");
  });

  test("content swap at same length counts as a change", () => {
    const prev = items(["m1", "m2"]);
    const next = items(["m1", "m2-edited"]);
    const action = decideItemsChangeAction({
      items: next,
      previousItems: prev,
      conversationKey: "conv-1",
      savedAnchor: null,
      isPinnedToLatest: true,
    });
    expect(action.kind).toBe("stick-to-latest");
  });
});

describe("decideItemsChangeAction — anchor-preserving prepend", () => {
  test("saved anchor present and found -> anchor-correct with new index", () => {
    const before = items(["m1", "m2", "m3"]);
    const afterPrepend = items(["o1", "o2", "m1", "m2", "m3"]);
    const action = decideItemsChangeAction({
      items: afterPrepend,
      previousItems: before,
      conversationKey: "conv-1",
      savedAnchor: { key: "m1", scrollTop: 42 },
      isPinnedToLatest: false,
    });
    expect(action).toEqual({
      kind: "anchor-correct",
      newIndex: 2,
      scrollTop: 42,
    });
  });

  test("anchor correction takes priority over stick-to-latest when both would fire", () => {
    const before = items(["m1"]);
    const afterPrepend = items(["o1", "m1", "m2"]);
    const action = decideItemsChangeAction({
      items: afterPrepend,
      previousItems: before,
      conversationKey: "conv-1",
      savedAnchor: { key: "m1", scrollTop: 123 },
      // Even if the caller thinks we're pinned, anchor must win.
      isPinnedToLatest: true,
    });
    expect(action.kind).toBe("anchor-correct");
  });

  test("saved anchor but key missing -> falls through to stick-to-latest when pinned", () => {
    const action = decideItemsChangeAction({
      items: items(["n1", "n2"]),
      previousItems: items(["m1"]),
      conversationKey: "conv-1",
      savedAnchor: { key: "m1-no-longer-present", scrollTop: 10 },
      isPinnedToLatest: true,
    });
    expect(action).toEqual({ kind: "stick-to-latest" });
  });
});

// ---------------------------------------------------------------------------
// Integration-style: wire the classification + decision helpers the way
// the hook does. These tests prove that applying `handleScroll`-style
// reasoning to a stream of scroll events produces the right side effects.
// ---------------------------------------------------------------------------

describe("integration — handleScroll-style dispatch via pure helpers", () => {
  test("onLoadOlder is called exactly once when near the top (column-reverse)", () => {
    const handle = makeHandle();
    const onLoadOlder = mock(() => {});
    // In column-reverse, near the top means distanceFromTop <= 200
    // distanceFromTop = 5000 - 800 - 4000 = 200
    const c = classifyScrollPosition(
      { scrollTop: 4000, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    // Classifier returns data only — no scroll commands.
    expect(handle.calls.scrollToLatest.length).toBe(0);
  });

  test("onLoadOlder is NOT called while isLoadingOlder=true", () => {
    const onLoadOlder = mock(() => {});
    for (const scrollTop of [4000, 4100, 4200]) {
      const c = classifyScrollPosition(
        { scrollTop, scrollHeight: 5000, clientHeight: 800 },
        { hasMore: true, isLoadingOlder: true, hasConversation: true },
      );
      if (c.shouldLoadOlder) onLoadOlder();
    }
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  test("pinned flips exactly at the 64 px threshold as the user scrolls up then back down", () => {
    // In column-reverse: distanceFromBottom = scrollTop
    let isPinned = true;
    const update = (scrollTop: number) => {
      const c = classifyScrollPosition(
        { scrollTop, scrollHeight: 1800, clientHeight: 800 },
        { hasMore: false, isLoadingOlder: false, hasConversation: true },
      );
      isPinned = c.isPinned;
    };
    update(0); // at bottom, distance 0
    expect(isPinned).toBe(true);
    update(64); // distance 64
    expect(isPinned).toBe(true);
    update(65); // distance 65 — flip
    expect(isPinned).toBe(false);
    update(64); // back to 64 — flip back
    expect(isPinned).toBe(true);
  });

  test("showScrollToLatest flips exactly at the 240 px threshold in both directions", () => {
    let show = false;
    const update = (scrollTop: number) => {
      const c = classifyScrollPosition(
        { scrollTop, scrollHeight: 1800, clientHeight: 800 },
        { hasMore: false, isLoadingOlder: false, hasConversation: true },
      );
      show = c.showScrollToLatest;
    };
    update(240); // distance 240 — still hidden
    expect(show).toBe(false);
    update(241); // distance 241 — flip on
    expect(show).toBe(true);
    update(240); // back to 240 — flip off
    expect(show).toBe(false);
  });

  test("anchor-preserving prepend: saved anchor -> anchor-correct on next items change", () => {
    const before = items(["m1", "m2", "m3"]);
    // Saved anchor captured during a load-older scroll event.
    const saved = { key: "m1", scrollTop: 150 };
    // New items arrive with two older messages prepended.
    const after = items(["o1", "o2", "m1", "m2", "m3"]);
    const action = decideItemsChangeAction({
      items: after,
      previousItems: before,
      conversationKey: "conv-1",
      savedAnchor: saved,
      isPinnedToLatest: false,
    });
    expect(action).toEqual({
      kind: "anchor-correct",
      newIndex: 2,
      scrollTop: 150,
    });
  });

  test("streaming growth: pinned -> scrollToLatest called; not pinned -> NOT called", () => {
    const handle = makeHandle();
    const prev = items(["m1"]);
    const grown = items(["m1", "m2"]);

    // Case 1: pinned — scrollToLatest fires.
    {
      const action = decideItemsChangeAction({
        items: grown,
        previousItems: prev,
        conversationKey: "conv-1",
        savedAnchor: null,
        isPinnedToLatest: true,
      });
      if (action.kind === "stick-to-latest") {
        handle.scrollToLatest({ behavior: "auto" });
      }
    }
    expect(handle.calls.scrollToLatest).toEqual([[{ behavior: "auto" }]]);

    // Case 2: not pinned — no scroll command.
    const handle2 = makeHandle();
    {
      const action = decideItemsChangeAction({
        items: grown,
        previousItems: prev,
        conversationKey: "conv-1",
        savedAnchor: null,
        isPinnedToLatest: false,
      });
      if (action.kind === "stick-to-latest") {
        handle2.scrollToLatest({ behavior: "auto" });
      }
    }
    expect(handle2.calls.scrollToLatest.length).toBe(0);
  });
});
