/**
 * Tests for `useLayoutViewportSize`, the live layout-viewport measurement the
 * onboarding and voice-room decorative layers read.
 *
 * The contract: the size comes from `layoutViewportSize`, so the fallback
 * dimensions have one owner rather than one per call site; it tracks `resize`;
 * and `enabled: false` opts out for a caller that already has a size from
 * context.
 *
 * The reference-stability test is load-bearing rather than cosmetic:
 * `useSyncExternalStore` bails out only on reference equality, so a
 * `getSnapshot` returning a fresh `{ w, h }` each call would re-render
 * forever. It fails loudly if that caching is ever dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useLayoutViewportSize,
  layoutViewportSize,
} from "@/hooks/use-element-size";

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

describe("useLayoutViewportSize", () => {
  test("reports the current window size", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useLayoutViewportSize());
    expect(result.current).toEqual({ w: 1024, h: 768 });
    // Same source of truth as every other layer on the screen.
    expect(result.current).toEqual(layoutViewportSize());
  });

  test("tracks a resize", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useLayoutViewportSize());

    setWindowSize(390, 844);
    fireResize();

    expect(result.current).toEqual({ w: 390, h: 844 });
  });

  test("keeps the same reference when a resize leaves the dimensions alone", () => {
    setWindowSize(1024, 768);
    const { result, rerender } = renderHook(() => useLayoutViewportSize());
    const first = result.current;

    // `resize` also fires for zoom, the iOS keyboard, and orientation changes
    // that settle back; none of those move the box.
    fireResize();
    rerender();

    expect(result.current).toBe(first);
  });

  test("shares one snapshot across consumers", () => {
    setWindowSize(1024, 768);
    const a = renderHook(() => useLayoutViewportSize());
    const b = renderHook(() => useLayoutViewportSize());

    expect(a.result.current).toBe(b.result.current);

    setWindowSize(390, 844);
    fireResize();

    expect(a.result.current).toEqual({ w: 390, h: 844 });
    expect(a.result.current).toBe(b.result.current);
  });

  test("does not re-subscribe while disabled, but still reports the size", () => {
    setWindowSize(1024, 768);
    const { result } = renderHook(() => useLayoutViewportSize(false));

    expect(result.current).toEqual({ w: 1024, h: 768 });

    // No subscription, so a resize does not notify this consumer. The value
    // is read during render, so it is never stale when something else
    // re-renders it.
    setWindowSize(390, 844);
    fireResize();

    expect(result.current).toEqual({ w: 1024, h: 768 });
  });
});
