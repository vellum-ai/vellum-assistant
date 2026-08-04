import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import {
  SIDEBAR_SECTION_MAX_HEIGHT,
  SIDEBAR_SECTION_RESIZE_MAX_HEIGHT,
  SIDEBAR_SECTION_RESIZE_MIN_HEIGHT,
} from "@/components/sidebar-nav-geometry";
import { clearUserScopedOverrides } from "@/utils/typed-storage";
import { withRejectedWrites } from "@/utils/rejected-writes.test-helper";
import {
  clampPinnedSectionHeight,
  resetPinnedSectionHeight,
  savePinnedSectionHeight,
  usePinnedSectionHeight,
} from "@/domains/chat/utils/sidebar-pinned-height";

const KEY = (assistantId: string) =>
  `vellum:sidebar-pinned-height:${assistantId}`;

afterEach(() => {
  localStorage.clear();
  // Accessors are module singletons, so a value held after a rejected write
  // outlives the test that set it. Logout clears these for the same reason.
  clearUserScopedOverrides();
});

describe("clampPinnedSectionHeight", () => {
  test("rounds and bounds to the resize range", () => {
    expect(clampPinnedSectionHeight(123.6)).toBe(124);
    expect(clampPinnedSectionHeight(-500)).toBe(
      SIDEBAR_SECTION_RESIZE_MIN_HEIGHT,
    );
    expect(clampPinnedSectionHeight(5000)).toBe(
      SIDEBAR_SECTION_RESIZE_MAX_HEIGHT,
    );
  });
});

describe("pinned section height storage", () => {
  test("defaults to the shared section cap", () => {
    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));

    expect(result.current).toBe(SIDEBAR_SECTION_MAX_HEIGHT);
  });

  test("persists per assistant, clamped, and reads back", () => {
    savePinnedSectionHeight("asst-1", 450);
    savePinnedSectionHeight("asst-2", 5000);

    expect(localStorage.getItem(KEY("asst-1"))).toBe("450");
    expect(localStorage.getItem(KEY("asst-2"))).toBe(
      String(SIDEBAR_SECTION_RESIZE_MAX_HEIGHT),
    );

    const first = renderHook(() => usePinnedSectionHeight("asst-1"));
    const second = renderHook(() => usePinnedSectionHeight("asst-2"));
    expect(first.result.current).toBe(450);
    expect(second.result.current).toBe(SIDEBAR_SECTION_RESIZE_MAX_HEIGHT);
  });

  test("junk in storage falls back to the default", () => {
    for (const raw of ["abc", "", "  ", "NaN"]) {
      localStorage.setItem(KEY("asst-1"), raw);

      const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));
      expect(result.current).toBe(SIDEBAR_SECTION_MAX_HEIGHT);
      clearUserScopedOverrides();
    }
  });

  test("a stored out-of-range height clamps rather than resets", () => {
    localStorage.setItem(KEY("asst-1"), "9999");

    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));

    expect(result.current).toBe(SIDEBAR_SECTION_RESIZE_MAX_HEIGHT);
  });

  test("reset returns the section to the default", () => {
    savePinnedSectionHeight("asst-1", 450);

    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));
    expect(result.current).toBe(450);

    act(() => resetPinnedSectionHeight("asst-1"));

    expect(localStorage.getItem(KEY("asst-1"))).toBeNull();
    expect(result.current).toBe(SIDEBAR_SECTION_MAX_HEIGHT);
  });
});

describe("usePinnedSectionHeight", () => {
  // The first render must already carry the stored choice: a flash of the
  // default cap would visibly snap the section on every sidebar mount.
  test("returns the stored value on the first render", () => {
    localStorage.setItem(KEY("asst-1"), "450");

    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));

    expect(result.current).toBe(450);
  });

  test("re-renders when the value is saved elsewhere", () => {
    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));
    expect(result.current).toBe(SIDEBAR_SECTION_MAX_HEIGHT);

    // Stands in for the other window: a save this hook never initiated.
    act(() => savePinnedSectionHeight("asst-1", 480));

    expect(result.current).toBe(480);
  });

  test("ignores writes for a different assistant", () => {
    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));

    act(() => savePinnedSectionHeight("asst-2", 480));

    expect(result.current).toBe(SIDEBAR_SECTION_MAX_HEIGHT);
  });

  // Storage is unavailable in private browsing and once quota is exhausted.
  // The divider still has to move: an unsaved height is tolerable, a handle
  // that snaps back on release is not.
  test("still resizes when storage rejects the write", () => {
    const { result } = renderHook(() => usePinnedSectionHeight("asst-1"));

    withRejectedWrites(() => {
      act(() => savePinnedSectionHeight("asst-1", 480));
    });

    expect(localStorage.getItem(KEY("asst-1"))).toBeNull();
    expect(result.current).toBe(480);
  });
});
