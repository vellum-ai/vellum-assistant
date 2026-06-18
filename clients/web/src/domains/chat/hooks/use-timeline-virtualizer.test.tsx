/**
 * Tests for `useTimelineVirtualizer` and its pure helpers.
 *
 * The pure `computeScrollMargin` is exercised directly (no DOM needed). The
 * hook itself gets a light smoke test: given a scroll-element ref it returns a
 * usable virtualizer object. Heavy DOM-measurement behavior is covered by the
 * consumer's tests (`subagent-timeline.test.tsx`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";

import {
  computeScrollMargin,
  useTimelineVirtualizer,
} from "@/domains/chat/hooks/use-timeline-virtualizer";

afterEach(() => {
  cleanup();
});

describe("computeScrollMargin", () => {
  /** Build a stub element with a fixed bounding-rect top. */
  function elAt(top: number, scrollTop = 0): HTMLElement {
    return {
      getBoundingClientRect: () => ({ top }) as DOMRect,
      scrollTop,
    } as unknown as HTMLElement;
  }

  test("returns 0 when either element is missing", () => {
    expect(computeScrollMargin(null, null)).toBe(0);
    expect(computeScrollMargin(elAt(120), null)).toBe(0);
    expect(computeScrollMargin(null, elAt(0))).toBe(0);
  });

  test("returns the list top relative to the scroll element", () => {
    // List 120px below the scroll container's top, container not scrolled.
    expect(computeScrollMargin(elAt(120), elAt(0))).toBe(120);
  });

  test("accounts for the scroll container's current scrollTop", () => {
    // Container scrolled 200px: the list box top has moved up by 200, so the
    // on-screen gap is -80, but the stable offset within content is 120.
    expect(computeScrollMargin(elAt(-80), elAt(0, 200))).toBe(120);
  });
});

describe("useTimelineVirtualizer", () => {
  test("returns a virtualizer with the expected shape", () => {
    const scrollRef = createRef<HTMLElement>();
    scrollRef.current = document.createElement("div");

    const { result } = renderHook(() =>
      useTimelineVirtualizer({
        count: 3,
        scrollRef,
        getItemKey: (index) => `row-${index}`,
      }),
    );

    expect(typeof result.current.getTotalSize).toBe("function");
    expect(Array.isArray(result.current.getVirtualItems())).toBe(true);
  });
});
