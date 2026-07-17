import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { renderHook, act } from "@testing-library/react";

import { useSwipeHorizontal } from "@/hooks/use-swipe-horizontal";

// ---------------------------------------------------------------------------
// Helpers — synthesize React-style TouchEvent objects for the hook handlers.
// ---------------------------------------------------------------------------

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function makeTouchList(touches: FakeTouch[]): TouchList {
  return touches as unknown as TouchList;
}

function makeTouchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: FakeTouch[],
  changedTouches: FakeTouch[] = [],
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
    target: null,
  } as unknown as React.TouchEvent;
}

// ---------------------------------------------------------------------------
// Test setup — force isPointerCoarse to return true so the hook arms.
// ---------------------------------------------------------------------------

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("coarse"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSwipeHorizontal", () => {
  test("does not fire callbacks when disabled", () => {
    const onSwipeLeft = mock(() => {});
    const onSwipeRight = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: false, onSwipeLeft, onSwipeRight }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 0, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 0, clientY: 100 },
        ]),
      ),
    );

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  test("fires onSwipeLeft when dragged left past the threshold", () => {
    const onSwipeLeft = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, onSwipeLeft }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 200, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 150, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  test("fires onSwipeRight when dragged right past the threshold", () => {
    const onSwipeRight = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, onSwipeRight }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 150, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 200, clientY: 100 },
        ]),
      ),
    );

    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  test("does not commit when drag is below the threshold", () => {
    const onSwipeLeft = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, onSwipeLeft, commitThresholdPx: 80 }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 70, clientY: 100 },
        ]),
      ),
    );
    // Only moved 50px — below the 80px threshold.
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 50, clientY: 100 },
        ]),
      ),
    );

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  test("cancels on vertical-dominant gestures", () => {
    const onSwipeLeft = mock(() => {});
    const onSwipeRight = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, onSwipeLeft, onSwipeRight }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    // Mostly vertical movement — should bail.
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 110, clientY: 300 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 110, clientY: 300 },
        ]),
      ),
    );

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  test("ignores a second finger landing mid-gesture", () => {
    const onSwipeLeft = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, onSwipeLeft }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 200, clientY: 100 },
        ]),
      ),
    );
    // Second finger lands — two touches.
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 180, clientY: 100 },
          { identifier: 1, clientX: 300, clientY: 200 },
        ]),
      ),
    );

    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  test("dragOffset tracks the finger 1:1 up to the threshold", () => {
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, commitThresholdPx: 100 }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 50, clientY: 100 },
        ]),
      ),
    );

    // 50px left, below 100px threshold — should be 1:1.
    expect(result.current.dragOffset).toBe(-50);
    expect(result.current.isDragging).toBe(true);
  });

  test("dragOffset is damped past the commit threshold", () => {
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true, commitThresholdPx: 100 }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 250, clientY: 100 },
        ]),
      ),
    );

    // 150px right, threshold 100 — damped: 100 + (150 - 100) * 0.35 = 117.5
    expect(result.current.dragOffset).toBe(117.5);
  });

  test("resets on touchcancel", () => {
    const { result } = renderHook(() =>
      useSwipeHorizontal({ enabled: true }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 50, clientY: 100 },
        ]),
      ),
    );
    expect(result.current.dragOffset).toBe(-50);

    act(() => result.current.onTouchCancel());
    expect(result.current.dragOffset).toBe(0);
    expect(result.current.isDragging).toBe(false);
  });
});
