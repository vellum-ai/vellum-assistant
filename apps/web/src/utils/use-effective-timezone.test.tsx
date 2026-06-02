import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let currentZone = "America/New_York";
let renderCount = 0;

// The hook re-reads `getEffectiveTimezone` on focus/visibility/override changes,
// so drive it from a mutable mock we can flip between renders.
mock.module("@/utils/effective-timezone", () => ({
  getEffectiveTimezone: () => currentZone,
}));

// Capture the watcher callback and its cleanup so we can fire the callback
// directly and assert the cleanup runs on unmount.
let watchCallback: (() => void) | null = null;
const unwatch = mock(() => {});
mock.module("@/utils/device-settings", () => ({
  watchDeviceSetting: (_name: string, cb: () => void) => {
    watchCallback = cb;
    return unwatch;
  },
}));

const { useEffectiveTimezone } = await import("@/utils/use-effective-timezone");

function renderTracked() {
  renderCount = 0;
  return renderHook(() => {
    renderCount += 1;
    return useEffectiveTimezone();
  });
}

beforeEach(() => {
  currentZone = "America/New_York";
  watchCallback = null;
  unwatch.mockClear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useEffectiveTimezone", () => {
  test("initial value equals getEffectiveTimezone()", () => {
    const { result } = renderHook(() => useEffectiveTimezone());
    expect(result.current).toBe("America/New_York");
  });

  test("updates on window focus when the zone changes", () => {
    const { result } = renderHook(() => useEffectiveTimezone());
    expect(result.current).toBe("America/New_York");

    currentZone = "Europe/Paris";
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current).toBe("Europe/Paris");
  });

  test("updates on visibilitychange to visible", () => {
    const { result } = renderHook(() => useEffectiveTimezone());

    currentZone = "Asia/Tokyo";
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current).toBe("Asia/Tokyo");
  });

  test("ignores visibilitychange when not visible", () => {
    const { result } = renderHook(() => useEffectiveTimezone());

    currentZone = "Asia/Tokyo";
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current).toBe("America/New_York");
  });

  test("updates when the device:timezone watcher fires", () => {
    const { result } = renderHook(() => useEffectiveTimezone());
    expect(watchCallback).not.toBeNull();

    currentZone = "Europe/London";
    act(() => {
      watchCallback?.();
    });

    expect(result.current).toBe("Europe/London");
  });

  test("calls the watcher cleanup on unmount", () => {
    const { unmount } = renderHook(() => useEffectiveTimezone());
    expect(unwatch).not.toHaveBeenCalled();

    unmount();

    expect(unwatch).toHaveBeenCalledTimes(1);
  });

  test("does not re-render when the recomputed value is unchanged", () => {
    const { result } = renderTracked();
    const initialRenders = renderCount;
    expect(result.current).toBe("America/New_York");

    // Zone unchanged — refresh should be a no-op, no extra render.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(renderCount).toBe(initialRenders);
    expect(result.current).toBe("America/New_York");
  });
});
