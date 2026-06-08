import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useBusSubscription", () => {
  test("invokes the handler when the named event is published", () => {
    const handler = mock(() => {});
    renderHook(() => useBusSubscription("app.online", handler));
    publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unsubscribes when the hook unmounts", () => {
    const handler = mock(() => {});
    const { unmount } = renderHook(() =>
      useBusSubscription("app.online", handler),
    );
    unmount();
    publish("app.online", {});
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not tear down and re-register on every render", () => {
    const handler = mock(() => {});
    const { rerender } = renderHook(
      ({ h }: { h: () => void }) => useBusSubscription("app.online", h),
      { initialProps: { h: handler } },
    );
    publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
    rerender({ h: handler });
    rerender({ h: handler });
    publish("app.online", {});
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
    publish("app.online", {});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("passes the typed payload to the handler", () => {
    const handler = mock((_: { signal: "visibility" | "app_state" | "online" }) => {});
    renderHook(() => useBusSubscription("app.resume", handler));
    publish("app.resume", { signal: "online" });
    expect(handler).toHaveBeenCalledWith({ signal: "online" });
  });

  test("handler captures the latest closure variables across renders", () => {
    // Regression coverage for the render-phase ref pattern: the
    // handler must always see the latest value of any variable
    // captured in its closure, not the value from the render it was
    // first registered in.
    const observed: number[] = [];
    function Hook({ value }: { value: number }) {
      useBusSubscription("app.online", () => {
        observed.push(value);
      });
    }
    const { rerender } = renderHook(({ v }: { v: number }) => Hook({ value: v }), {
      initialProps: { v: 1 },
    });
    publish("app.online", {});
    rerender({ v: 2 });
    publish("app.online", {});
    rerender({ v: 3 });
    publish("app.online", {});
    expect(observed).toEqual([1, 2, 3]);
  });

  test("re-subscribes when the event name prop changes", () => {
    const handler = mock(() => {});
    const { rerender } = renderHook(
      ({ ev }: { ev: "app.online" | "app.offline" }) =>
        useBusSubscription(ev, handler),
      { initialProps: { ev: "app.online" } },
    );
    publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
    rerender({ ev: "app.offline" });
    publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
    publish("app.offline", {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("multiple consumers of the same event all receive every publish", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    renderHook(() => {
      useBusSubscription("app.online", a);
      useBusSubscription("app.online", b);
    });
    publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
