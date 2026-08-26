/**
 * Tests for `useQuestionCardMinimize`, the minimize state and vertical drag
 * behind the pending `ask_question` card.
 *
 * Two things are worth pinning down here. The first is `progress`: every moving
 * part of the card reads it, so its resting values and the way a live drag maps
 * onto it are the whole animation contract. The second is the click a drag
 * leaves behind, because the card's drag surface covers the option rows, and a
 * gesture that released into one of those would answer the question the user
 * was only trying to get out of the way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent, TouchEvent } from "react";

import {
  MINIMIZE_COMMIT_PX,
  MINIMIZE_TRAVEL_PX,
  collapseProgress,
  expandedChromeOpacity,
  minimizedChromeOpacity,
  useQuestionCardMinimize,
} from "@/domains/chat/hooks/use-question-card-minimize";

// ---------------------------------------------------------------------------
// Touch-event helpers, mirroring `use-swipe-vertical.test.ts`
// ---------------------------------------------------------------------------

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touchEvent(
  type: "touchstart" | "touchmove" | "touchend",
  touches: FakeTouch[],
  changedTouches: FakeTouch[] = [],
): TouchEvent {
  return {
    type,
    touches: touches as unknown as TouchList,
    changedTouches: changedTouches as unknown as TouchList,
    targetTouches: touches as unknown as TouchList,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as TouchEvent;
}

function finger(clientY: number): FakeTouch {
  return { identifier: 1, clientX: 0, clientY };
}

const START_Y = 200;

function setPointer(coarse: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query.includes("coarse"),
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
  setPointer(true);
});

afterEach(() => {
  setPointer(false);
});

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe("collapseProgress", () => {
  test("rests at 1 expanded and 0 minimized", () => {
    expect(collapseProgress(false, 0)).toBe(1);
    expect(collapseProgress(true, 0)).toBe(0);
  });

  test("a downward drag from expanded runs progress to 0 over the travel", () => {
    expect(collapseProgress(false, MINIMIZE_TRAVEL_PX / 2)).toBeCloseTo(0.5);
    expect(collapseProgress(false, MINIMIZE_TRAVEL_PX)).toBe(0);
  });

  test("an upward drag from minimized runs progress back to 1", () => {
    expect(collapseProgress(true, -MINIMIZE_TRAVEL_PX / 2)).toBeCloseTo(0.5);
    expect(collapseProgress(true, -MINIMIZE_TRAVEL_PX)).toBe(1);
  });

  test("clamps at both ends so overdrag has nowhere to go", () => {
    expect(collapseProgress(false, MINIMIZE_TRAVEL_PX * 3)).toBe(0);
    expect(collapseProgress(false, -MINIMIZE_TRAVEL_PX)).toBe(1);
    expect(collapseProgress(true, MINIMIZE_TRAVEL_PX)).toBe(0);
  });
});

describe("chrome opacities", () => {
  test("the two crossfades never overlap", () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const both =
        expandedChromeOpacity(progress) > 0 &&
        minimizedChromeOpacity(progress) > 0;
      expect(both).toBe(false);
    }
  });

  test("each is fully opaque at its own resting state", () => {
    expect(expandedChromeOpacity(1)).toBe(1);
    expect(expandedChromeOpacity(0)).toBe(0);
    expect(minimizedChromeOpacity(0)).toBe(1);
    expect(minimizedChromeOpacity(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// State and gesture
// ---------------------------------------------------------------------------

describe("useQuestionCardMinimize", () => {
  test("starts expanded", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());

    expect(result.current.isMinimized).toBe(false);
    expect(result.current.progress).toBe(1);
    expect(result.current.dragAttr).toBeUndefined();
  });

  test("toggle flips the state and expand only ever opens", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());

    act(() => result.current.toggle());
    expect(result.current.isMinimized).toBe(true);
    expect(result.current.progress).toBe(0);

    act(() => result.current.expand());
    expect(result.current.isMinimized).toBe(false);

    act(() => result.current.expand());
    expect(result.current.isMinimized).toBe(false);
  });

  test("a downward drag tracks the finger before it commits", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    const half = MINIMIZE_TRAVEL_PX / 2;

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchMove(
        touchEvent("touchmove", [finger(START_Y + half)]),
      );
    });

    expect(result.current.isDragging).toBe(true);
    expect(result.current.dragAttr).toBe("true");
    expect(result.current.progress).toBeCloseTo(0.5);
    // Still expanded: the state only changes when the finger comes up.
    expect(result.current.isMinimized).toBe(false);
  });

  test("releasing past the commit distance minimizes", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    const travel = MINIMIZE_COMMIT_PX + 10;

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchMove(
        touchEvent("touchmove", [finger(START_Y + travel)]),
      );
      result.current.dragHandlers.onTouchEnd(
        touchEvent("touchend", [], [finger(START_Y + travel)]),
      );
    });

    expect(result.current.isMinimized).toBe(true);
    expect(result.current.isDragging).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  test("releasing short of the commit distance springs back", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    const travel = MINIMIZE_COMMIT_PX - 10;

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchMove(
        touchEvent("touchmove", [finger(START_Y + travel)]),
      );
      result.current.dragHandlers.onTouchEnd(
        touchEvent("touchend", [], [finger(START_Y + travel)]),
      );
    });

    expect(result.current.isMinimized).toBe(false);
    expect(result.current.progress).toBe(1);
  });

  test("an upward drag past the commit distance expands a minimized card", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    const travel = MINIMIZE_COMMIT_PX + 10;

    act(() => result.current.toggle());

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchMove(
        touchEvent("touchmove", [finger(START_Y - travel)]),
      );
      result.current.dragHandlers.onTouchEnd(
        touchEvent("touchend", [], [finger(START_Y - travel)]),
      );
    });

    expect(result.current.isMinimized).toBe(false);
  });

  test("the click a drag leaves behind is swallowed, and only that one", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    let stopped = 0;
    const click = () =>
      ({
        stopPropagation: () => {
          stopped += 1;
        },
        preventDefault: () => {},
      }) as unknown as ReactMouseEvent;

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchMove(
        touchEvent("touchmove", [finger(START_Y + 30)]),
      );
      result.current.dragHandlers.onTouchEnd(
        touchEvent("touchend", [], [finger(START_Y + 30)]),
      );
    });

    act(() => result.current.dragHandlers.onClickCapture(click()));
    expect(stopped).toBe(1);

    // The next click is a real one: the drag is over and the flag went with it.
    act(() => result.current.dragHandlers.onClickCapture(click()));
    expect(stopped).toBe(1);
  });

  test("a tap that never moves leaves the following click alone", () => {
    const { result } = renderHook(() => useQuestionCardMinimize());
    let stopped = 0;
    const click = () =>
      ({
        stopPropagation: () => {
          stopped += 1;
        },
        preventDefault: () => {},
      }) as unknown as ReactMouseEvent;

    act(() => {
      result.current.dragHandlers.onTouchStart(
        touchEvent("touchstart", [finger(START_Y)]),
      );
      result.current.dragHandlers.onTouchEnd(
        touchEvent("touchend", [], [finger(START_Y)]),
      );
    });

    act(() => result.current.dragHandlers.onClickCapture(click()));
    expect(stopped).toBe(0);
  });
});
