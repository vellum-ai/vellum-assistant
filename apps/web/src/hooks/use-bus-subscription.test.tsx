import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { __resetEventBusForTesting, useEventBusStore } from "@/stores/event-bus-store.js";
import { subscribeBus, useBusSubscription } from "@/hooks/use-bus-subscription.js";

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useBusSubscription", () => {
  test("invokes the handler when the named event is published", () => {
    const handler = mock(() => {});
    renderHook(() => useBusSubscription("app.online", handler));
    useEventBusStore.getState().publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unsubscribes when the hook unmounts", () => {
    const handler = mock(() => {});
    const { unmount } = renderHook(() =>
      useBusSubscription("app.online", handler),
    );
    unmount();
    useEventBusStore.getState().publish("app.online", {});
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not tear down and re-register on every render", () => {
    const handler = mock(() => {});
    const { rerender } = renderHook(
      ({ h }: { h: () => void }) => useBusSubscription("app.online", h),
      { initialProps: { h: handler } },
    );
    useEventBusStore.getState().publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
    rerender({ h: handler });
    rerender({ h: handler });
    useEventBusStore.getState().publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("always reads the latest handler reference (no stale closure)", () => {
    const first = mock(() => {});
    const second = mock(() => {});
    const { rerender } = renderHook(
      ({ h }: { h: () => void }) => useBusSubscription("app.online", h),
      { initialProps: { h: first } },
    );
    rerender({ h: second });
    useEventBusStore.getState().publish("app.online", {});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("passes the typed payload to the handler", () => {
    const handler = mock((_: { signal: "visibility" | "app_state" | "online" }) => {});
    renderHook(() => useBusSubscription("app.resume", handler));
    useEventBusStore.getState().publish("app.resume", { signal: "online" });
    expect(handler).toHaveBeenCalledWith({ signal: "online" });
  });
});

describe("subscribeBus", () => {
  test("returns an unsubscribe function that stops delivery", () => {
    const handler = mock(() => {});
    const unsubscribe = subscribeBus("app.offline", handler);
    useEventBusStore.getState().publish("app.offline", {});
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    useEventBusStore.getState().publish("app.offline", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("multiple subscribers receive independent unsubscribe handles", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const unsubA = subscribeBus("app.offline", a);
    subscribeBus("app.offline", b);
    unsubA();
    useEventBusStore.getState().publish("app.offline", {});
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
