import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useEmailCardDismissed } from "./use-email-card-dismissed";
import { useEmailPinned } from "./use-email-pinned";

afterEach(() => {
  localStorage.clear();
});

describe("useEmailPinned", () => {
  test("pins and unpins per assistant, and toggles", () => {
    const { result } = renderHook(() => useEmailPinned("asst-1"));
    const other = renderHook(() => useEmailPinned("asst-2"));
    expect(result.current.pinned).toBe(false);

    act(() => result.current.pin());
    expect(result.current.pinned).toBe(true);
    expect(other.result.current.pinned).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.pinned).toBe(false);
  });

  test("with no assistant nothing is pinned and pinning is a no-op", () => {
    const { result } = renderHook(() => useEmailPinned(null));
    act(() => result.current.pin());
    expect(result.current.pinned).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});

describe("useEmailCardDismissed", () => {
  test("remembers the closed card and restores it", () => {
    const { result } = renderHook(() => useEmailCardDismissed("asst-1"));
    expect(result.current.dismissed).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    act(() => result.current.restore());
    expect(result.current.dismissed).toBe(false);
  });
});
