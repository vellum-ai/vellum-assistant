import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, act } from "@testing-library/react";

import { __resetForTesting, subscribe } from "@/lib/event-bus";
import type { NotificationTapPayload } from "@/runtime/notifications";

let capturedHandler: ((payload: NotificationTapPayload) => void) | null = null;
const setNotificationTapHandlerMock = mock(
  (handler: (payload: NotificationTapPayload) => void) => {
    capturedHandler = handler;
  },
);
mock.module("@/runtime/notifications", () => ({
  setNotificationTapHandler: setNotificationTapHandlerMock,
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
// Full Sentry surface — `mock.module` is process-global in bun, so a
// partial mock would shadow `captureException` (used by `runtime/event-sources/*`
// and `sse-service`) for every later test file in the run.
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

const { useNotificationTapNavigation } =
  await import("./use-notification-tap-navigation");

beforeEach(() => {
  __resetForTesting();
  capturedHandler = null;
  setNotificationTapHandlerMock.mockClear();
  sentryBreadcrumbMock.mockClear();
  window.history.pushState(null, "", "/");
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  window.history.pushState(null, "", "/");
});

describe("useNotificationTapNavigation", () => {
  test("mounting registers a tap handler", () => {
    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).toHaveBeenCalledTimes(1);
    expect(capturedHandler).not.toBeNull();
  });

  test("a pop-out window registers no tap handler", () => {
    window.history.pushState(null, "", "/?popout=1");

    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).not.toHaveBeenCalled();
    expect(capturedHandler).toBeNull();
  });

  test("a tap with a conversationId publishes deeplink.openThread", () => {
    renderHook(() => useNotificationTapNavigation());

    const received: Array<{ threadId: string }> = [];
    subscribe("deeplink.openThread", (payload) => {
      received.push(payload);
    });

    act(() => {
      capturedHandler?.({ conversationId: "abc", sourceEventName: "x" });
    });

    expect(received).toEqual([{ threadId: "abc" }]);
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
  });

  test("a tap without a conversationId publishes nothing", () => {
    renderHook(() => useNotificationTapNavigation());

    const received: Array<{ threadId: string }> = [];
    subscribe("deeplink.openThread", (payload) => {
      received.push(payload);
    });

    act(() => {
      capturedHandler?.({ sourceEventName: "x" });
    });

    expect(received).toEqual([]);
    expect(sentryBreadcrumbMock).toHaveBeenCalledTimes(1);
    const args = sentryBreadcrumbMock.mock.calls[0]?.[0] as {
      category?: string;
      message?: string;
      data?: { sourceEventName?: string };
    };
    expect(args.category).toBe("notification");
    expect(args.message).toBe("tap_without_conversation");
    expect(args.data?.sourceEventName).toBe("x");
  });
});
