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

// The hook subscribes to the cross-domain bus `app.resume` signal via
// `useBusSubscription`, which calls `subscribe` from `@/lib/event-bus`.
// Capture the registered event + handler so we can invoke it directly, and
// expose an unsubscribe mock so we can assert teardown on unmount.
let busEvent: string | null = null;
let busHandler: (() => void) | null = null;
const busUnsubscribe = mock(() => {});
mock.module("@/lib/event-bus", () => ({
  subscribe: (event: string, handler: () => void) => {
    busEvent = event;
    busHandler = handler;
    return busUnsubscribe;
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
  busEvent = null;
  busHandler = null;
  unwatch.mockClear();
  busUnsubscribe.mockClear();
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

  test("subscribes to the bus `app.resume` signal", () => {
    renderHook(() => useEffectiveTimezone());
    expect(busEvent).toBe("app.resume");
    expect(busHandler).not.toBeNull();
  });

  test("updates when the bus `app.resume` signal fires", () => {
    const { result } = renderHook(() => useEffectiveTimezone());

    currentZone = "Asia/Tokyo";
    act(() => {
      busHandler?.();
    });

    expect(result.current).toBe("Asia/Tokyo");
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

  test("calls the watcher and bus cleanups on unmount", () => {
    const { unmount } = renderHook(() => useEffectiveTimezone());
    expect(unwatch).not.toHaveBeenCalled();
    expect(busUnsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(busUnsubscribe).toHaveBeenCalledTimes(1);
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
