import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { renderHook, act } from "@testing-library/react";

import { useSwipeVertical } from "@/hooks/use-swipe-vertical";

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
    // touchmove/touchend carry the standard Event fields but the hook never
    // reads them — stub enough to satisfy the type.
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
  // The hook gates on isPointerCoarse(). happy-dom's matchMedia doesn't
  // populate media-query results by default, so stub it.
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: true } as MediaQueryList) as typeof window.matchMedia;
  }
  // Ensure matchMedia returns matches: true for the coarse-pointer query.
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
  // Restore a reasonable default.
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

describe("useSwipeVertical", () => {
  test("does not fire callbacks when disabled", () => {
    const onSwipeDown = mock(() => {});
    const onSwipeUp = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: false, onSwipeDown, onSwipeUp }),
    );

    const start = makeTouchEvent("touchstart", [
      { identifier: 0, clientX: 100, clientY: 100 },
    ]);
    act(() => result.current.onTouchStart(start));

    const move = makeTouchEvent("touchmove", [
      { identifier: 0, clientX: 100, clientY: 200 },
    ]);
    act(() => result.current.onTouchMove(move));

    const end = makeTouchEvent(
      "touchend",
      [],
      [{ identifier: 0, clientX: 100, clientY: 200 }],
    );
    act(() => result.current.onTouchEnd(end));

    expect(onSwipeDown).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  test("fires onSwipeDown when dragged down past the threshold", () => {
    const onSwipeDown = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, onSwipeDown }),
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
          { identifier: 0, clientX: 100, clientY: 150 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 100, clientY: 200 },
        ]),
      ),
    );

    expect(onSwipeDown).toHaveBeenCalledTimes(1);
  });

  test("fires onSwipeUp when dragged up past the threshold", () => {
    const onSwipeUp = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, onSwipeUp }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 200 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 100, clientY: 150 },
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

    expect(onSwipeUp).toHaveBeenCalledTimes(1);
  });

  test("does not commit when drag is below the threshold", () => {
    const onSwipeDown = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, onSwipeDown, commitThresholdPx: 80 }),
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
          { identifier: 0, clientX: 100, clientY: 130 },
        ]),
      ),
    );
    // Only moved 50px — below the 80px threshold.
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 100, clientY: 150 },
        ]),
      ),
    );

    expect(onSwipeDown).not.toHaveBeenCalled();
  });

  test("cancels on horizontal-dominant gestures", () => {
    const onSwipeDown = mock(() => {});
    const onSwipeUp = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, onSwipeDown, onSwipeUp }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    // Mostly horizontal movement — should bail.
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 300, clientY: 110 },
        ]),
      ),
    );
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 300, clientY: 110 },
        ]),
      ),
    );

    expect(onSwipeDown).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  test("ignores a second finger landing mid-gesture", () => {
    const onSwipeDown = mock(() => {});
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, onSwipeDown }),
    );

    act(() =>
      result.current.onTouchStart(
        makeTouchEvent("touchstart", [
          { identifier: 0, clientX: 100, clientY: 100 },
        ]),
      ),
    );
    // Second finger lands — two touches.
    act(() =>
      result.current.onTouchMove(
        makeTouchEvent("touchmove", [
          { identifier: 0, clientX: 100, clientY: 120 },
          { identifier: 1, clientX: 200, clientY: 200 },
        ]),
      ),
    );

    // Gesture should have been reset; a subsequent touchend should not commit.
    act(() =>
      result.current.onTouchEnd(
        makeTouchEvent("touchend", [], [
          { identifier: 0, clientX: 100, clientY: 200 },
        ]),
      ),
    );

    expect(onSwipeDown).not.toHaveBeenCalled();
  });

  test("dragOffset tracks the finger 1:1 up to the threshold", () => {
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, commitThresholdPx: 100 }),
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
          { identifier: 0, clientX: 100, clientY: 150 },
        ]),
      ),
    );

    // 50px down, below 100px threshold — should be 1:1.
    expect(result.current.dragOffset).toBe(50);
    expect(result.current.isDragging).toBe(true);
  });

  test("dragOffset is damped past the commit threshold", () => {
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true, commitThresholdPx: 100 }),
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
          { identifier: 0, clientX: 100, clientY: 250 },
        ]),
      ),
    );

    // 150px drag, threshold 100 — damped: 100 + (150 - 100) * 0.35 = 117.5
    expect(result.current.dragOffset).toBe(117.5);
  });

  test("resets on touchcancel", () => {
    const { result } = renderHook(() =>
      useSwipeVertical({ enabled: true }),
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
          { identifier: 0, clientX: 100, clientY: 150 },
        ]),
      ),
    );
    expect(result.current.dragOffset).toBe(50);

    act(() => result.current.onTouchCancel());
    expect(result.current.dragOffset).toBe(0);
    expect(result.current.isDragging).toBe(false);
  });
});
