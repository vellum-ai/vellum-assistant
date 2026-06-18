/**
 * Tests for `useTimelineVirtualizer` and its pure helpers.
 *
 * The pure `computeScrollMargin` is exercised directly (no DOM needed). The
 * hook itself gets a light smoke test: given a scroll-element ref it returns a
 * usable virtualizer object. Heavy DOM-measurement behavior is covered once a
 * consumer wires the hook in a later PR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";

import {
  computeScrollMargin,
  DEFAULT_ROW_ESTIMATE,
  OVERSCAN,
  useTimelineVirtualizer,
} from "@/domains/chat/hooks/use-timeline-virtualizer";

afterEach(() => {
  cleanup();
});

describe("computeScrollMargin", () => {
  test("returns 0 for a null element", () => {
    expect(computeScrollMargin(null)).toBe(0);
  });

  test("returns the element's offsetTop", () => {
    const stub = { offsetTop: 120 } as HTMLElement;
    expect(computeScrollMargin(stub)).toBe(120);
  });
});

describe("module constants", () => {
  test("expose sane defaults", () => {
    expect(DEFAULT_ROW_ESTIMATE).toBe(96);
    expect(OVERSCAN).toBe(6);
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
