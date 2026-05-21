import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

type EventHandler = (event: AssistantEvent) => void;
type ReconnectHandler = (cause: "error" | "watchdog") => void;

let activeOnEvent: EventHandler | null = null;
let activeOnError: ((err: Error) => void) | null = null;
let activeOnReconnect: ReconnectHandler | null = null;
let lastSubscribeArgs: {
  assistantId: string;
  conversationKey: string | null | undefined;
} | null = null;
const cancelMock = mock(() => {});
const subscribeChatEventsMock = mock(
  (
    assistantId: string,
    conversationKey: string | null | undefined,
    onEvent: EventHandler,
    onError: (err: Error) => void,
    options?: { onReconnect?: ReconnectHandler },
  ) => {
    lastSubscribeArgs = { assistantId, conversationKey };
    activeOnEvent = onEvent;
    activeOnError = onError;
    activeOnReconnect = options?.onReconnect ?? null;
    return { cancel: cancelMock };
  },
);

mock.module("@/domains/chat/api/stream.js", () => ({
  subscribeChatEvents: subscribeChatEventsMock,
}));

const { useEventBusInit } = await import("@/hooks/use-event-bus-init.js");

beforeEach(() => {
  __resetEventBusForTesting();
  activeOnEvent = null;
  activeOnError = null;
  activeOnReconnect = null;
  lastSubscribeArgs = null;
  cancelMock.mockClear();
  subscribeChatEventsMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useEventBusInit — SSE ownership", () => {
  test("does not open SSE when assistant is not active", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: false,
        checkAssistant: () => {},
      }),
    );
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("does not open SSE when assistantId is null", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("opens a single unfiltered SSE when assistant becomes active", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs).toEqual({
      assistantId: "asst-1",
      conversationKey: null,
    });
  });

  test("re-broadcasts every SSE event on bus.sse.event", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.event", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    const event = { type: "avatar_updated" } as AssistantEvent;
    activeOnEvent!(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  test("publishes sse.opened with cause=fresh on first open", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.opened", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    expect(handler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "fresh",
    });
  });

  test("publishes sse.opened with cause=watchdog when stream reconnects after a watchdog stall", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.opened", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    handler.mockClear();
    activeOnReconnect!("watchdog");
    expect(handler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "watchdog",
    });
  });

  test("publishes sse.closed on transport error", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.closed", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    activeOnError!(new Error("network error"));
    expect(handler).toHaveBeenCalledWith({ reason: "network error" });
  });

  test("cancels the SSE on unmount", () => {
    const { unmount } = renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    expect(cancelMock).not.toHaveBeenCalled();
    unmount();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("does not publish sse.closed for intentional teardowns (app.hidden, reachability retry)", () => {
    const closedHandler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.closed", closedHandler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    useEventBusStore
      .getState()
      .publish("app.hidden", { signal: "visibility" });
    useEventBusStore
      .getState()
      .publish("reachability.retry-requested", {});
    expect(closedHandler).not.toHaveBeenCalled();
  });

  test("tears down SSE on app.hidden and reopens on app.resume after the dedup window", async () => {
    const checkAssistant = mock(() => {});
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    useEventBusStore
      .getState()
      .publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    // Wait past the 1s dedup window so the resume is not collapsed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    useEventBusStore
      .getState()
      .publish("app.resume", { signal: "visibility" });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistant).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("reachability.retry-requested bounces the SSE connection", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    useEventBusStore
      .getState()
      .publish("reachability.retry-requested", {});
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });
});

describe("useEventBusInit — DOM event sources", () => {
  test("publishes app.online and app.resume{signal:'online'} on window online", () => {
    const onlineHandler = mock(() => {});
    const resumeHandler = mock(() => {});
    useEventBusStore.getState().subscribe("app.online", onlineHandler);
    useEventBusStore.getState().subscribe("app.resume", resumeHandler);
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
        checkAssistant: () => {},
      }),
    );
    window.dispatchEvent(new Event("online"));
    expect(onlineHandler).toHaveBeenCalledTimes(1);
    expect(resumeHandler).toHaveBeenCalledWith({ signal: "online" });
  });

  test("publishes app.offline on window offline", () => {
    const offlineHandler = mock(() => {});
    useEventBusStore.getState().subscribe("app.offline", offlineHandler);
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
        checkAssistant: () => {},
      }),
    );
    window.dispatchEvent(new Event("offline"));
    expect(offlineHandler).toHaveBeenCalledTimes(1);
  });
});
