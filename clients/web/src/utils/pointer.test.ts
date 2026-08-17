import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

import { isPointerCoarse, usePointerCoarse } from "./pointer";

// Both forms answer `(pointer: coarse)`, so drive them the way every other
// platform-adaptation suite does: by stubbing `window.matchMedia` for a device
// shape. See `docs/PLATFORM_ADAPTATION.md`.
const viewport = viewportAxesStub();

afterEach(() => {
  cleanup();
  viewport.restore();
});

describe("isPointerCoarse", () => {
  test("reports the primary pointer", () => {
    viewport.set({ narrow: true, coarsePointer: true });
    expect(isPointerCoarse()).toBe(true);

    viewport.set({ narrow: false, coarsePointer: false });
    expect(isPointerCoarse()).toBe(false);
  });

  test("is a width-independent signal", () => {
    // A tablet has room to spare and still has no mouse.
    viewport.set({ narrow: false, coarsePointer: true });
    expect(isPointerCoarse()).toBe(true);
  });
});

describe("usePointerCoarse", () => {
  test("reads the same query as a subscribed snapshot", () => {
    viewport.set({ narrow: true, coarsePointer: true });
    const { result } = renderHook(() => usePointerCoarse());
    expect(result.current).toBe(true);
  });

  test("re-reads the pointer rather than caching the mount-time answer", () => {
    // GIVEN a convertible being driven by touch
    viewport.set({ narrow: true, coarsePointer: true });
    const { result, rerender } = renderHook(() => usePointerCoarse());
    expect(result.current).toBe(true);

    // WHEN its keyboard is reattached
    viewport.set({ narrow: true, coarsePointer: false });
    rerender();

    // THEN the hook reports the pointer it has now, which is what the one-shot
    // `isPointerCoarse()` cannot do
    expect(result.current).toBe(false);
  });
});
