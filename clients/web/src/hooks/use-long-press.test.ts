import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useLongPress } from "@/hooks/use-long-press";

/**
 * Helper: install a window.matchMedia stub that reports `coarse` for the
 * `(pointer: coarse)` query. Restored in `afterEach`.
 */
function setPointerCoarse(coarse: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: mock((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: mock(() => {}),
      removeListener: mock(() => {}),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      dispatchEvent: mock(() => false),
    })),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

function makeTouchEvent(
  x: number,
  y: number,
): React.TouchEvent<HTMLElement> {
  return {
    touches: [{ clientX: x, clientY: y } as Touch],
  } as unknown as React.TouchEvent<HTMLElement>;
}

beforeEach(() => {
  setPointerCoarse(true);
});

afterEach(() => {
  cleanup();
  // matchMedia restore is handled by setPointerCoarse's return, but we
  // call setPointerCoarse(false) to reset to a known state for the next test.
  setPointerCoarse(false);
  // Re-enable coarse for the next test via beforeEach.
});

describe("useLongPress", () => {
  test("fires callback after the threshold elapses", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));

    // Callback should not fire immediately.
    expect(callback).not.toHaveBeenCalled();

    // Wait past the threshold.
    await new Promise((r) => setTimeout(r, 150));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("cancels when the user moves beyond the tolerance", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));
    // Move 20px — exceeds the 10px tolerance.
    result.current.onTouchMove(makeTouchEvent(120, 200));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("does not cancel for small movements within tolerance", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));
    // Move 5px — within the 10px tolerance.
    result.current.onTouchMove(makeTouchEvent(105, 200));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("cancels on touch end before threshold", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));
    result.current.onTouchEnd();

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("cancels on touch cancel before threshold", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));
    result.current.onTouchCancel();

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("does not fire on non-coarse (desktop) pointers", async () => {
    const restore = setPointerCoarse(false);
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    result.current.onTouchStart(makeTouchEvent(100, 200));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
    restore();
  });
});
