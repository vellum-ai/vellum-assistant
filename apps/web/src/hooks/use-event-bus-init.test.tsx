import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEvent } from "@/types/event-types";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store";

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

mock.module("@/domains/chat/api/stream", () => ({
  subscribeChatEvents: subscribeChatEventsMock,
}));

const { useEventBusInit } = await import("@/hooks/use-event-bus-init");

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

  test("reachability-driven reopen labels sse.opened with cause='error', not 'resume'", () => {
    const openedHandler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.opened", openedHandler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    openedHandler.mockClear();
    useEventBusStore
      .getState()
      .publish("reachability.retry-requested", {});
    expect(openedHandler).toHaveBeenCalledTimes(1);
    expect(openedHandler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "error",
    });
  });

  test("app.resume after app.hidden labels the reopen with cause='resume'", async () => {
    const openedHandler = mock(() => {});
    useEventBusStore.getState().subscribe("sse.opened", openedHandler);
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
        checkAssistant: () => {},
      }),
    );
    openedHandler.mockClear();
    useEventBusStore
      .getState()
      .publish("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    useEventBusStore
      .getState()
      .publish("app.resume", { signal: "visibility" });
    expect(openedHandler).toHaveBeenCalledTimes(1);
    expect(openedHandler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "resume",
    });
  }, 5_000);

  test("app.resume inside the dedup window does NOT reopen the SSE", async () => {
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
    // Two rapid resumes inside the 1s dedup window — only the first
    // should land a reopen and a checkAssistant call.
    useEventBusStore
      .getState()
      .publish("app.resume", { signal: "visibility" });
    useEventBusStore
      .getState()
      .publish("app.resume", { signal: "app_state" });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistant).toHaveBeenCalledTimes(1);
  });

  test("does NOT reopen the SSE on app.resume while a connection is still live", () => {
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
      .publish("app.resume", { signal: "visibility" });
    // Stream is still open (no app.hidden first), so app.resume only
    // triggers a checkAssistant — no new subscribeChatEvents call.
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(checkAssistant).toHaveBeenCalledTimes(1);
  });

  test("does NOT tear down on app.hidden when no connection is live", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
        checkAssistant: () => {},
      }),
    );
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
    useEventBusStore
      .getState()
      .publish("app.hidden", { signal: "visibility" });
    // No `current` to cancel — must not throw and not increase counts.
    expect(cancelMock).not.toHaveBeenCalled();
  });

  test("changing assistantId tears down the previous connection and opens a new one", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useEventBusInit({
          assistantId: id,
          isAssistantActive: id != null,
          checkAssistant: () => {},
        }),
      { initialProps: { id: "asst-1" } as { id: string | null } },
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs?.assistantId).toBe("asst-1");
    rerender({ id: "asst-2" });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(lastSubscribeArgs?.assistantId).toBe("asst-2");
  });

  test("flipping to inactive tears the SSE down without re-opening", () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useEventBusInit({
          assistantId: "asst-1",
          isAssistantActive: active,
          checkAssistant: () => {},
        }),
      { initialProps: { active: true } },
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
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
