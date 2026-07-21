/**
 * Tests for `useRotatingIndex`.
 *
 * bun:test ships no `useFakeTimers` equivalent, so the hook's `setInterval` is
 * driven by monkey-patching the global: each interval the hook registers is
 * captured, then fired from `act()` to advance the index without real time.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { useRotatingIndex } from "./use-rotating-index";

interface IntervalHandle {
  id: number;
  fn: () => void;
  cleared: boolean;
}

let intervals: IntervalHandle[] = [];
let nextId = 1;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

/** Fires every live captured interval once, inside act(). */
function tick() {
  act(() => {
    for (const handle of intervals) {
      if (!handle.cleared) {
        handle.fn();
      }
    }
  });
}

beforeEach(() => {
  intervals = [];
  nextId = 1;
  originalSetInterval = globalThis.setInterval;
  originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    const handle: IntervalHandle = { id: nextId++, fn, cleared: false };
    intervals.push(handle);
    return handle.id as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    const handle = intervals.find((h) => h.id === id);
    if (handle) {
      handle.cleared = true;
    }
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  cleanup();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("useRotatingIndex", () => {
  test("advances each interval and wraps at count", () => {
    const { result } = renderHook(() =>
      useRotatingIndex(3, { intervalMs: 1000, enabled: true }),
    );

    expect(result.current).toBe(0);
    tick();
    expect(result.current).toBe(1);
    tick();
    expect(result.current).toBe(2);
    tick();
    expect(result.current).toBe(0);
  });

  test("stays at 0 when count <= 1", () => {
    const { result } = renderHook(() =>
      useRotatingIndex(1, { intervalMs: 1000, enabled: true }),
    );

    expect(result.current).toBe(0);
    // No interval should have been registered.
    expect(intervals.length).toBe(0);
    tick();
    expect(result.current).toBe(0);
  });

  test("stays at 0 when disabled", () => {
    const { result } = renderHook(() =>
      useRotatingIndex(3, { intervalMs: 1000, enabled: false }),
    );

    expect(result.current).toBe(0);
    expect(intervals.length).toBe(0);
    tick();
    expect(result.current).toBe(0);
  });

  test("clamps to 0..count-1 on the render where count shrinks", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useRotatingIndex(count, { intervalMs: 1000, enabled: true }),
      { initialProps: { count: 3 } },
    );

    tick();
    tick();
    expect(result.current).toBe(2);

    // Shrink the list below the current index. The reset effect only runs after
    // commit, so the returned value must already be clamped on this render.
    rerender({ count: 2 });
    expect(result.current).toBeLessThanOrEqual(1);
  });

  test("clears the interval on unmount — no advance afterwards", () => {
    const { result, unmount } = renderHook(() =>
      useRotatingIndex(3, { intervalMs: 1000, enabled: true }),
    );

    tick();
    expect(result.current).toBe(1);

    unmount();
    expect(intervals.every((h) => h.cleared)).toBe(true);
    tick();
    // The value is captured at unmount; firing a cleared interval is a no-op.
    expect(result.current).toBe(1);
  });
});
