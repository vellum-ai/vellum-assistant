/**
 * Tests for `useWindowSize`, the live window measurement four onboarding
 * layers read.
 *
 * The contract worth pinning is the part callers used to hand-roll: that the
 * size comes from `windowSize` (so the SSR guard and the FALLBACK dimensions
 * have one owner rather than being restated per call site), that it tracks
 * `resize`, that a `resize` reporting unchanged dimensions does not churn a
 * render, and that `enabled: false` opts out of the listener entirely for the
 * caller that already has a size from context.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useWindowSize, windowSize } from "@/hooks/use-element-size";

function setWindowSize(w: number, h: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: w,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: h,
  });
}

/** Fire a `resize` the way the browser does, inside React's act scope. */
function fireResize(): void {
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => {
  cleanup();
});

describe("useWindowSize", () => {
  test("reports the current window size", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useWindowSize());
    expect(result.current).toEqual({ w: 1024, h: 768 });
    // Same source of truth as every other layer on the screen.
    expect(result.current).toEqual(windowSize());
  });

  test("tracks a resize", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useWindowSize());

    setWindowSize(390, 844);
    fireResize();

    expect(result.current).toEqual({ w: 390, h: 844 });
  });

  test("does not re-render when a resize leaves the dimensions alone", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useWindowSize());
    const first = result.current;

    // `resize` also fires for zoom, the iOS keyboard, and orientation changes
    // that settle back; none of those move the box.
    fireResize();

    expect(result.current).toBe(first);
  });

  test("ignores resizes while disabled", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useWindowSize(false));

    setWindowSize(390, 844);
    fireResize();

    expect(result.current).toEqual({ w: 1024, h: 768 });
  });

  test("starts tracking when it becomes enabled", () => {
    setWindowSize(1024, 768);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWindowSize(enabled),
      { initialProps: { enabled: false } },
    );

    setWindowSize(390, 844);
    rerender({ enabled: true });

    // Enabling syncs immediately rather than waiting for the next resize:
    // the window can move while a provider is supplying the size.
    expect(result.current).toEqual({ w: 390, h: 844 });
  });
});
