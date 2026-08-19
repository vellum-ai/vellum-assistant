/**
 * Tests for `useSwipeCloseDrawer`, the mobile drawer's swipe-to-close.
 *
 * The pure helpers are covered directly; the hook itself is driven through
 * `renderHook` with synthesized React touch events, the harness
 * `use-swipe-horizontal.test.ts` established for the engine underneath.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import {
  closingOffset,
  startsOnSwipeActionRow,
  useSwipeCloseDrawer,
} from "@/hooks/use-swipe-close-drawer";

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function makeTouchList(touches: FakeTouch[]): TouchList {
  return touches as unknown as TouchList;
}

function makeTouchEvent(
  type: "touchstart" | "touchmove" | "touchend",
  touches: FakeTouch[],
  changedTouches: FakeTouch[] = [],
  target: EventTarget | null = null,
): React.TouchEvent {
  return {
    type,
    touches: makeTouchList(touches),
    changedTouches: makeTouchList(changedTouches),
    targetTouches: makeTouchList(touches),
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: {} as TouchEvent,
    bubbles: false,
    cancelable: false,
    currentTarget: null,
    defaultPrevented: false,
    eventPhase: 0,
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    isTrusted: false,
    persist: () => {},
    timeStamp: 0,
    target,
  } as unknown as React.TouchEvent;
}

function coarsePointer(matches: boolean) {
  return ((query: string) => ({
    matches: matches && query.includes("coarse"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.matchMedia = coarsePointer(true);
});

afterEach(() => {
  window.matchMedia = coarsePointer(false);
  document.body.replaceChildren();
});

describe("startsOnSwipeActionRow", () => {
  test("is true on a marked row and its descendants", () => {
    const row = document.createElement("div");
    row.setAttribute("data-slot", "swipe-action-row");
    const label = document.createElement("span");
    row.appendChild(label);
    document.body.appendChild(row);

    expect(startsOnSwipeActionRow(row)).toBe(true);
    expect(startsOnSwipeActionRow(label)).toBe(true);
  });

  test("is false on the rest of the drawer", () => {
    // The header, the assistant cluster, section headings and the space below
    // the list are all fair game for the close gesture.
    const header = document.createElement("header");
    document.body.appendChild(header);

    expect(startsOnSwipeActionRow(header)).toBe(false);
    expect(startsOnSwipeActionRow(null)).toBe(false);
    expect(startsOnSwipeActionRow(document)).toBe(false);
  });
});

describe("closingOffset", () => {
  test("passes leftward travel through", () => {
    expect(closingOffset(-40)).toBe(-40);
    expect(closingOffset(-120)).toBe(-120);
  });

  test("clamps rightward travel, so the panel keeps its left edge", () => {
    expect(closingOffset(40)).toBe(0);
    expect(closingOffset(0)).toBe(0);
  });
});

describe("useSwipeCloseDrawer", () => {
  function drag(
    result: { current: ReturnType<typeof useSwipeCloseDrawer> },
    dx: number,
    target: EventTarget | null = null,
  ) {
    const start = { identifier: 1, clientX: 300, clientY: 400 };
    const end = { identifier: 1, clientX: 300 + dx, clientY: 400 };
    act(() => {
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [start], [], target),
      );
    });
    act(() => {
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [end], [], target),
      );
    });
    act(() => {
      result.current.onTouchEnd(makeTouchEvent("touchend", [], [end], target));
    });
  }

  test("closes on a leftward swipe past the threshold", () => {
    const onClose = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: true, onClose }),
    );

    drag(result, -120);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("leaves a short drag alone, so the panel springs back", () => {
    const onClose = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: true, onClose }),
    );

    drag(result, -20);

    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  test("ignores a rightward swipe, which has nowhere to go", () => {
    const onClose = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: true, onClose }),
    );

    drag(result, 120);

    expect(onClose).not.toHaveBeenCalled();
  });

  test("yields a drag that began on a row with its own swipe actions", () => {
    // Archive lives on that row's leftward swipe. The drawer standing down here
    // is what keeps it reachable.
    const onClose = mock(() => {});
    const row = document.createElement("div");
    row.setAttribute("data-slot", "swipe-action-row");
    const label = document.createElement("span");
    row.appendChild(label);
    document.body.appendChild(row);
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: true, onClose }),
    );

    drag(result, -120, label);

    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  test("takes the same drag when it began off a row", () => {
    const onClose = mock(() => {});
    const heading = document.createElement("h2");
    document.body.appendChild(heading);
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: true, onClose }),
    );

    drag(result, -120, heading);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("stays inert while disabled, i.e. the drawer is closed", () => {
    const onClose = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeCloseDrawer({ enabled: false, onClose }),
    );

    drag(result, -120);

    expect(onClose).not.toHaveBeenCalled();
  });
});
