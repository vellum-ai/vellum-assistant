import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useLongPress } from "@/hooks/use-long-press";

/**
 * Helper: install a window.matchMedia stub that reports `coarse` for the
 * `(pointer: coarse)` query. Returns a restore function.
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
  target: Element | null = null,
): React.TouchEvent<HTMLElement> {
  return {
    touches: [{ clientX: x, clientY: y } as Touch],
    target,
  } as unknown as React.TouchEvent<HTMLElement>;
}

/**
 * Restore function captured from setPointerCoarse(true) in beforeEach.
 * Calling this in afterEach restores the REAL matchMedia instead of
 * installing another mock whose restore function is discarded.
 */
let restoreMatchMedia: (() => void) | null = null;

beforeEach(() => {
  restoreMatchMedia = setPointerCoarse(true);
});

afterEach(() => {
  cleanup();
  // Restore the original matchMedia captured by setPointerCoarse(true).
  // Calling setPointerCoarse(false) instead would install ANOTHER mock
  // and discard its restore function, leaving the original permanently
  // stubbed for later test suites in the same worker.
  restoreMatchMedia?.();
  restoreMatchMedia = null;
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

  test("does not fire when the touch target is an interactive element", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    const link = document.createElement("a");
    result.current.onTouchStart(makeTouchEvent(100, 200, link));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("does not fire when the touch target is a button", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    const button = document.createElement("button");
    result.current.onTouchStart(makeTouchEvent(100, 200, button));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("does not fire when an ancestor of the target is interactive", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    // Simulate a touch on a <span> nested inside an <a>.
    const link = document.createElement("a");
    const span = document.createElement("span");
    link.appendChild(span);
    result.current.onTouchStart(makeTouchEvent(100, 200, span));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("does not fire when shouldSkip returns true for the target", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() =>
      useLongPress(callback, 100, { shouldSkip: () => true }),
    );

    result.current.onTouchStart(makeTouchEvent(100, 200));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("fires when shouldSkip returns false for the target", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() =>
      useLongPress(callback, 100, { shouldSkip: () => false }),
    );

    result.current.onTouchStart(makeTouchEvent(100, 200));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("does not fire when the target has role=button", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    const div = document.createElement("div");
    div.setAttribute("role", "button");
    result.current.onTouchStart(makeTouchEvent(100, 200, div));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).not.toHaveBeenCalled();
  });

  test("fires when the touch target is a plain non-interactive element", async () => {
    const callback = mock(() => {});
    const { result } = renderHook(() => useLongPress(callback, 100));

    const div = document.createElement("div");
    result.current.onTouchStart(makeTouchEvent(100, 200, div));

    await new Promise((r) => setTimeout(r, 150));

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
