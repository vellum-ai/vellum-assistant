import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { clearUserScopedOverrides } from "@/utils/typed-storage";
import { withRejectedWrites } from "@/utils/rejected-writes.test-helper";
import {
  DEFAULT_SIDEBAR_VIEW_MODE,
  loadViewMode,
  saveViewMode,
  useViewMode,
} from "@/domains/chat/utils/sidebar-view-mode";

const KEY = (assistantId: string) =>
  `vellum:sidebar-view-mode:${assistantId}`;

afterEach(() => {
  localStorage.clear();
  // Accessors are module singletons, so a value held after a rejected write
  // outlives the test that set it. Logout clears these for the same reason.
  clearUserScopedOverrides();
});

describe("sidebar view mode storage", () => {
  test("defaults to the flat All view", () => {
    expect(loadViewMode("asst-1")).toBe("all");
    expect(DEFAULT_SIDEBAR_VIEW_MODE).toBe("all");
  });

  test("persists per assistant and reads back", () => {
    saveViewMode("asst-1", "grouped");

    expect(localStorage.getItem(KEY("asst-1"))).toBe("grouped");
    expect(loadViewMode("asst-1")).toBe("grouped");
    // A second assistant keeps the default until it is switched itself.
    expect(loadViewMode("asst-2")).toBe("all");
  });

  test("an unrecognized stored view falls back to the default", () => {
    localStorage.setItem(KEY("asst-1"), "channels");

    expect(loadViewMode("asst-1")).toBe("all");
  });
});

describe("useViewMode", () => {
  // The regression test for the flash this hook exists to remove: the very
  // first render must already carry the stored choice, with no effect, no act,
  // and no second commit in between.
  test("returns the stored value on the first render", () => {
    localStorage.setItem(KEY("asst-1"), "grouped");

    const { result } = renderHook(() => useViewMode("asst-1"));

    expect(result.current).toBe("grouped");
  });

  test("re-renders when the value is saved elsewhere", () => {
    const { result } = renderHook(() => useViewMode("asst-1"));
    expect(result.current).toBe("all");

    // Stands in for the other window: a save that this hook never initiated.
    act(() => saveViewMode("asst-1", "grouped"));

    expect(result.current).toBe("grouped");
  });

  test("ignores writes for a different assistant", () => {
    const { result } = renderHook(() => useViewMode("asst-1"));

    act(() => saveViewMode("asst-2", "grouped"));

    expect(result.current).toBe("all");
  });

  // Storage is unavailable in private browsing and once quota is exhausted.
  // The switch still has to move: an unsaved choice is tolerable, a control
  // that ignores clicks is not.
  test("still switches when storage rejects the write", () => {
    const { result } = renderHook(() => useViewMode("asst-1"));
    expect(result.current).toBe("all");

    withRejectedWrites(() => {
      act(() => saveViewMode("asst-1", "grouped"));
    });

    // The switch moved even though nothing reached storage.
    expect(localStorage.getItem("vellum:sidebar-view-mode:asst-1")).toBeNull();
    expect(result.current).toBe("grouped");
  });

  test("follows the key when the assistant changes", () => {
    saveViewMode("asst-2", "grouped");

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useViewMode(id),
      { initialProps: { id: "asst-1" } },
    );
    expect(result.current).toBe("all");

    rerender({ id: "asst-2" });

    expect(result.current).toBe("grouped");
  });
});
