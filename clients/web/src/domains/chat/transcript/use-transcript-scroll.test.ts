/**
 * Tests for the transcript scroll coordinator.
 *
 * The coordinator's load-bearing decisions live in pure helpers
 * (`classifyScrollPosition`, `findAnchorIndex`, `findLatestUserAnchorKey`,
 * `computePrependDelta`) so they can be unit-tested without a render cycle.
 * The hook itself is a thin wiring layer on top of those helpers; its
 * scroll-event / load-older timing is covered separately in
 * `use-transcript-scroll.burst.test.tsx`.
 *
 * The transcript uses plain `flex-col` (chronological order):
 *   - distanceFromTop    = scrollTop
 *   - distanceFromBottom = scrollHeight − clientHeight − scrollTop
 * scrollTop = 0 is the visual top (oldest); scrollTop = max is the
 * visual bottom (latest).
 */

import { describe, expect, mock, test } from "bun:test";

import type { TranscriptItem } from "@/domains/chat/transcript/types";
import {
  classifyScrollPosition,
  computePrependDelta,
  findAnchorIndex,
  findLatestUserAnchorKey,
  PINNED_THRESHOLD_PX,
  SHOW_SCROLL_BUTTON_THRESHOLD_PX,
} from "@/domains/chat/transcript/transcript-scroll-utils";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(id: string): TranscriptItem {
  // Build a minimal MessageItem. The hook never inspects `message` fields;
  // only `key`/`kind` identity matters for the scroll coordinator.
  return {
    kind: "message",
    key: id,
    message: {
      id,
      role: "assistant",
      ...textBody(""),
    },
  };
}

/** Like `makeMessage` but with `role: "user"`, used by tests that exercise
 *  the latest-user-anchor lookup. */
function makeUserMessage(id: string): TranscriptItem {
  return {
    kind: "message",
    key: id,
    message: {
      id,
      role: "user",
      ...textBody(""),
    },
  };
}

function items(ids: readonly string[]): TranscriptItem[] {
  return ids.map(makeMessage);
}

/** Build ScrollMetrics positioned at a given distance from the bottom,
 *  for a transcript with `scrollHeight = 1800, clientHeight = 800`
 *  (max scrollTop = 1000). */
function metricsAtDistanceFromBottom(distance: number) {
  return { scrollTop: 1000 - distance, scrollHeight: 1800, clientHeight: 800 };
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
  const getScrollState = mock(() => ({
    distanceFromBottom: 0,
    isPinned: false,
    showScrollToLatest: false,
    shouldLoadOlder: false,
  }));
  return {
    scrollToLatest,
    scrollToMessage: mock((): boolean => false),
    getScrollElement,
    getViewportHeight,
    getScrollState,
    calls,
  };
}

// ---------------------------------------------------------------------------
// classifyScrollPosition — flex-col thresholds
//
// In flex-col: scrollTop = max is the bottom (latest).
// distanceFromBottom = scrollHeight - clientHeight - scrollTop
// distanceFromTop    = scrollTop
// ---------------------------------------------------------------------------

describe("classifyScrollPosition — pinned threshold (64 px)", () => {
  test("at the bottom (max scrollTop) is pinned", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(0),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(0);
    expect(c.isPinned).toBe(true);
  });

  test("distance exactly 64 is pinned (<=)", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(64),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(PINNED_THRESHOLD_PX);
    expect(c.isPinned).toBe(true);
  });

  test("distance 65 is NOT pinned", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(65),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(65);
    expect(c.isPinned).toBe(false);
  });

  test("iOS rubber-band over-bottom (scrollTop > max) clamps distanceFromBottom to 0", () => {
    // scrollTop briefly larger than max during rubber-band — distance must
    // not flip negative or the pill would flicker on.
    const c = classifyScrollPosition(
      { scrollTop: 1050, scrollHeight: 1800, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(0);
    expect(c.isPinned).toBe(true);
  });
});

describe("classifyScrollPosition — show-scroll-button threshold (240 px)", () => {
  test("distance 240 does NOT show the button (>)", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(240),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(SHOW_SCROLL_BUTTON_THRESHOLD_PX);
    expect(c.showScrollToLatest).toBe(false);
  });

  test("distance 241 shows the button", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(241),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(241);
    expect(c.showScrollToLatest).toBe(true);
  });

  test("dropping back under 240 hides the button", () => {
    const c = classifyScrollPosition(
      metricsAtDistanceFromBottom(239),
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.distanceFromBottom).toBe(239);
    expect(c.showScrollToLatest).toBe(false);
  });
});

describe("classifyScrollPosition — load-older threshold (200 px)", () => {
  test("scrolled to the top triggers load-older", () => {
    // distanceFromTop = scrollTop. We want scrollTop <= 200 to trigger.
    const c = classifyScrollPosition(
      { scrollTop: 200, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(true);
  });

  test("one pixel below threshold does NOT trigger load-older", () => {
    const c = classifyScrollPosition(
      { scrollTop: 201, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when isLoadingOlder is true", () => {
    const c = classifyScrollPosition(
      { scrollTop: 100, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: true, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when hasMore is false", () => {
    const c = classifyScrollPosition(
      { scrollTop: 100, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(false);
  });

  test("does not trigger when hasConversation is false", () => {
    const c = classifyScrollPosition(
      { scrollTop: 100, scrollHeight: 5000, clientHeight: 800 },
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
// findLatestUserAnchorKey
//
// Backs the submit-detection branch in `Transcript`. The component compares
// this render's key to the previous render's key — when they differ
// (typically because the user just sent a new message), it pins the new
// anchor to the viewport top so the response streams into the space below.
// ---------------------------------------------------------------------------

describe("findLatestUserAnchorKey", () => {
  test("returns null on an empty list", () => {
    expect(findLatestUserAnchorKey([])).toBeNull();
  });

  test("returns null when no user-role messages are present", () => {
    // assistant-only transcript (pre-first-user state)
    const list = items(["a1", "a2", "a3"]);
    expect(findLatestUserAnchorKey(list)).toBeNull();
  });

  test("returns the key of the only user message", () => {
    const list: TranscriptItem[] = [
      makeUserMessage("u1"),
      makeMessage("a1"),
      makeMessage("a2"),
    ];
    expect(findLatestUserAnchorKey(list)).toBe("u1");
  });

  test("returns the LATEST user message when multiple exist", () => {
    // Walks backward, so the trailing user message wins.
    const list: TranscriptItem[] = [
      makeUserMessage("u1"),
      makeMessage("a1"),
      makeUserMessage("u2"),
      makeMessage("a2"),
      makeUserMessage("u3"),
      makeMessage("a3"),
    ];
    expect(findLatestUserAnchorKey(list)).toBe("u3");
  });

  test("ignores trailing assistant items when finding the anchor", () => {
    // Streaming response items extend past the anchor user message.
    const list: TranscriptItem[] = [
      makeMessage("a1"),
      makeUserMessage("u1"),
      makeMessage("a2"),
      makeMessage("a3"),
      makeMessage("a4"),
    ];
    expect(findLatestUserAnchorKey(list)).toBe("u1");
  });

  test("detects a new submit: key changes when a new user message lands", () => {
    // Models the items-effect's diff: previous render's anchor vs.
    // current render's anchor. A different return value means a new
    // user message just joined the list — submit detected.
    const before: TranscriptItem[] = [
      makeUserMessage("u1"),
      makeMessage("a1"),
      makeMessage("a2"),
    ];
    const afterSubmit: TranscriptItem[] = [
      ...before,
      makeUserMessage("u2"),
    ];

    const prevAnchor = findLatestUserAnchorKey(before);
    const newAnchor = findLatestUserAnchorKey(afterSubmit);
    expect(prevAnchor).toBe("u1");
    expect(newAnchor).toBe("u2");
    expect(newAnchor !== prevAnchor).toBe(true);
  });

  test("does NOT detect a new submit during streaming growth", () => {
    // Assistant items append while the user anchor is unchanged.
    const before: TranscriptItem[] = [
      makeUserMessage("u1"),
      makeMessage("a1"),
    ];
    const midStream: TranscriptItem[] = [...before, makeMessage("a2")];

    const prevAnchor = findLatestUserAnchorKey(before);
    const newAnchor = findLatestUserAnchorKey(midStream);
    expect(prevAnchor).toBe("u1");
    expect(newAnchor).toBe("u1");
    // The hook's "is new anchor" predicate requires a string change.
    expect(newAnchor !== prevAnchor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computePrependDelta
//
// Drives virtuoso's `firstItemIndex` decrement so an older-page prepend keeps
// the viewport visually stable. Returns the prepended count ONLY for a pure
// front-prepend; every other shape (append, in-place growth, mixed
// prepend+append, replace, shrink, first render) returns 0 so the index is
// left untouched and stable `computeItemKey` handles reconciliation.
// ---------------------------------------------------------------------------

describe("computePrependDelta", () => {
  test("first render (no baseline key) returns 0", () => {
    expect(computePrependDelta(items(["m1", "m2"]), null, 0)).toBe(0);
  });

  test("pure front-prepend returns the prepended count", () => {
    // prev first key "m1" (len 3) now sits at index 2 after 2 older items.
    const after = items(["o1", "o2", "m1", "m2", "m3"]);
    expect(computePrependDelta(after, "m1", 3)).toBe(2);
  });

  test("append-only returns 0 (old first item stays at the front)", () => {
    const after = items(["m1", "m2", "m3"]);
    expect(computePrependDelta(after, "m1", 2)).toBe(0);
  });

  test("mixed prepend+append returns 0 (don't mis-shift)", () => {
    // Grew by 2, but the old first key moved only 1 slot → not a pure prepend.
    const after = items(["o1", "m1", "m2", "m3"]);
    expect(computePrependDelta(after, "m1", 2)).toBe(0);
  });

  test("same length (content swap / streaming in-place) returns 0", () => {
    const after = items(["m1", "m2-edited"]);
    expect(computePrependDelta(after, "m1", 2)).toBe(0);
  });

  test("shrink returns 0", () => {
    expect(computePrependDelta(items(["m2", "m3"]), "m1", 3)).toBe(0);
  });

  test("old first key absent after a replace returns 0", () => {
    const after = items(["n1", "n2", "n3"]);
    expect(computePrependDelta(after, "m1", 2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration-style: wire the classification + decision helpers the way
// the hook does. These tests prove that applying `handleScroll`-style
// reasoning to a stream of scroll events produces the right side effects.
// ---------------------------------------------------------------------------

describe("integration — handleScroll-style dispatch via pure helpers", () => {
  test("onLoadOlder is called exactly once when near the top", () => {
    const handle = makeHandle();
    const onLoadOlder = mock(() => {});
    // distanceFromTop = scrollTop. scrollTop = 200 ⇒ load-older fires.
    const c = classifyScrollPosition(
      { scrollTop: 200, scrollHeight: 5000, clientHeight: 800 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    // Classifier returns data only — no scroll commands.
    expect(handle.calls.scrollToLatest.length).toBe(0);
  });

  test("onLoadOlder is NOT called while isLoadingOlder=true", () => {
    const onLoadOlder = mock(() => {});
    for (const scrollTop of [50, 100, 150]) {
      const c = classifyScrollPosition(
        { scrollTop, scrollHeight: 5000, clientHeight: 800 },
        { hasMore: true, isLoadingOlder: true, hasConversation: true },
      );
      if (c.shouldLoadOlder) onLoadOlder();
    }
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  test("pinned flips exactly at the 64 px threshold as the user scrolls up then back down", () => {
    let isPinned = true;
    const updateByDistanceFromBottom = (distance: number) => {
      const c = classifyScrollPosition(
        metricsAtDistanceFromBottom(distance),
        { hasMore: false, isLoadingOlder: false, hasConversation: true },
      );
      isPinned = c.isPinned;
    };
    updateByDistanceFromBottom(0); // at bottom
    expect(isPinned).toBe(true);
    updateByDistanceFromBottom(64);
    expect(isPinned).toBe(true);
    updateByDistanceFromBottom(65); // flip
    expect(isPinned).toBe(false);
    updateByDistanceFromBottom(64); // flip back
    expect(isPinned).toBe(true);
  });

  test("showScrollToLatest flips exactly at the 240 px threshold in both directions", () => {
    let show = false;
    const updateByDistanceFromBottom = (distance: number) => {
      const c = classifyScrollPosition(
        metricsAtDistanceFromBottom(distance),
        { hasMore: false, isLoadingOlder: false, hasConversation: true },
      );
      show = c.showScrollToLatest;
    };
    updateByDistanceFromBottom(240); // still hidden
    expect(show).toBe(false);
    updateByDistanceFromBottom(241); // flip on
    expect(show).toBe(true);
    updateByDistanceFromBottom(240); // flip off
    expect(show).toBe(false);
  });

  test("anchor-preserving prepend: pure front-prepend yields a non-zero delta", () => {
    // The prepend correction now rides virtuoso's `firstItemIndex` via
    // `computePrependDelta` rather than a saved-anchor scrollTop fix-up.
    const after = items(["o1", "o2", "m1", "m2", "m3"]);
    expect(computePrependDelta(after, "m1", 3)).toBe(2);
  });

  test("streaming growth never triggers an auto-scroll", () => {
    const handle = makeHandle();
    // In-place growth at the tail (a streaming response) is not a prepend, so
    // `firstItemIndex` is left untouched and no scroll command is issued.
    const grown = items(["m1", "m2"]);
    expect(computePrependDelta(grown, "m1", 1)).toBe(0);
    expect(handle.calls.scrollToLatest.length).toBe(0);
  });
});

// Regression for the items-effect underfilled-viewport kick. Captured
// scrollState from the bug report (2026-05-22):
//
//   { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370,
//     hasMore: true, isLoadingOlder: false, itemCount: 2,
//     shouldLoadOlder: true, diagnosis: "NEAR TOP ... but NOT loading" }
//
// scrollHeight === clientHeight means the user CANNOT scroll. handleScroll
// can never fire, so without an items-effect kick the load-older path
// stays gated forever even though `shouldLoadOlder=true`. These tests
// lock in the precise classification and the dispatch contract.
describe("integration — items-effect dispatch on underfilled viewport", () => {
  test("scrollHeight === clientHeight with hasMore=true classifies as shouldLoadOlder=true", () => {
    const c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    expect(c.shouldLoadOlder).toBe(true);
    // Underfilled also reads as pinned-to-latest (distanceFromBottom=0
    // is well under the 64 px threshold) — the items effect needs to be
    // willing to load AND keep `isPinned=true`.
    expect(c.isPinned).toBe(true);
    expect(c.distanceFromBottom).toBe(0);
  });

  test("items-effect-style dispatch fires onLoadOlder when classify says so", () => {
    // Mirrors the hook's items-effect path: read DOM metrics, classify,
    // and if `shouldLoadOlder` is true, call `onLoadOlder()`. This is
    // the call site the bug was missing — `handleScroll` had it,
    // the items effect did not.
    const onLoadOlder = mock(() => {});
    const c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  test("items-effect dispatch does NOT fire when a load is already in flight", () => {
    // After the first kick lands, `isLoadingOlder` flips to true. The
    // next items change (e.g. an unrelated re-render) must NOT fire a
    // second kick — `classification.shouldLoadOlder` is the only gate
    // and it must reflect that.
    const onLoadOlder = mock(() => {});
    const c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: true, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  test("items-effect dispatch stops kicking once viewport overflows", () => {
    // After enough older pages prepend, scrollHeight exceeds
    // clientHeight + LOAD_OLDER_THRESHOLD_PX (200 px). The cascade
    // terminates: classify reports shouldLoadOlder=false and the kick
    // does not fire.
    const onLoadOlder = mock(() => {});
    const c = classifyScrollPosition(
      // scrollTop bumped well below the 200 px threshold (the auto-pin
      // window will have re-pinned to latest, so scrollTop sits near
      // the bottom of an overflowing viewport).
      { scrollTop: 5000, scrollHeight: 6370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  test("items-effect dispatch stops kicking once hasMore=false", () => {
    // Conversation has fewer messages than fit in the viewport AND no
    // older history exists. The cascade must terminate cleanly with no
    // further calls.
    const onLoadOlder = mock(() => {});
    const c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: false, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  test("chain-load: false→true→false sequence kicks again when still underfilled", () => {
    // Codex P1 regression. The dispatch site must observe the CURRENT
    // render's isLoadingOlder flag, not a stale ref. Sequence:
    //   1. Initial:    isLoadingOlder=false, items underfill → kick.
    //   2. Loading:    isLoadingOlder=true,  same items     → no kick.
    //   3. Prepended:  isLoadingOlder=false, items grew but still
    //                  underfill → MUST kick again to chain-load.
    // If the dispatch reads a stale flag from the previous render, step 3
    // sees isLoadingOlder=true and silently skips the kick, stranding
    // conversations that need multiple older pages to overflow.
    const onLoadOlder = mock(() => {});

    // Step 1: initial, underfilled
    let c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // Step 2: loading in flight
    c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 1370, clientHeight: 1370 },
      { hasMore: true, isLoadingOlder: true, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // Step 3: prepend landed but still underfilled
    c = classifyScrollPosition(
      { scrollTop: 0, scrollHeight: 2200, clientHeight: 2200 },
      { hasMore: true, isLoadingOlder: false, hasConversation: true },
    );
    if (c.shouldLoadOlder) onLoadOlder();
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});
