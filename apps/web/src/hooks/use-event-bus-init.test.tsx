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

mock.module("@/lib/streaming/stream-transport", () => ({
  subscribeChatEvents: subscribeChatEventsMock,
}));

// `useEventBusInit` reads `checkAssistant` from the lifecycle store at
// resume time. Mock the store so tests can assert on the call without
// running the real lifecycle hook.
const checkAssistantMock = mock(async () => {});
mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: {
    getState: () => ({ checkAssistant: checkAssistantMock }),
  },
}));

// Capture the deep-link subscription callback so tests can fire
// "live" links. Allow each test to seed the drain return value.
type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };
let activeDeepLinkCallback: ((link: DeepLink) => void) | null = null;
let pendingDeepLinksFixture: DeepLink[] = [];
const subscribeToDeepLinksMock = mock((cb: (link: DeepLink) => void) => {
  activeDeepLinkCallback = cb;
  return () => {
    activeDeepLinkCallback = null;
  };
});
const drainPendingDeepLinksMock = mock(async (): Promise<DeepLink[]> => {
  const drained = pendingDeepLinksFixture;
  pendingDeepLinksFixture = [];
  return drained;
});
mock.module("@/runtime/deep-links", () => ({
  drainPendingDeepLinks: drainPendingDeepLinksMock,
  subscribeToDeepLinks: subscribeToDeepLinksMock,
}));

const { useEventBusInit } = await import("@/hooks/use-event-bus-init");

beforeEach(() => {
  __resetEventBusForTesting();
  activeOnEvent = null;
  activeOnError = null;
  activeOnReconnect = null;
  lastSubscribeArgs = null;
  activeDeepLinkCallback = null;
  pendingDeepLinksFixture = [];
  cancelMock.mockClear();
  subscribeChatEventsMock.mockClear();
  checkAssistantMock.mockClear();
  subscribeToDeepLinksMock.mockClear();
  drainPendingDeepLinksMock.mockClear();
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
      }),
    );
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("does not open SSE when assistantId is null", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("opens a single unfiltered SSE when assistant becomes active", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
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
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
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
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("power.suspend tears down a live SSE so the daemon sees us go away cleanly", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    useEventBusStore.getState().publish("power.suspend", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("power.suspend is a no-op when no SSE is open", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(0);

    useEventBusStore.getState().publish("power.suspend", {});

    // Nothing to tear down — cancel was never wired in the first place.
    expect(cancelMock).toHaveBeenCalledTimes(0);
  });

  test("power.resume bounces a LIVE SSE (no preceding app.hidden) — the tray-resident case", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledTimes(0);

    // No app.hidden first — the renderer stayed visible during system
    // sleep (tray-resident / full-screen). power.resume must tear down
    // and reopen, otherwise the half-dead socket persists.
    useEventBusStore.getState().publish("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("power.unlock bounces a LIVE SSE — screen lock can outlast TCP timeouts", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    useEventBusStore.getState().publish("power.unlock", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("power.resume reopens the SSE after teardown — same dedup window as app.resume", async () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    useEventBusStore.getState().publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    useEventBusStore.getState().publish("power.resume", {});
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("power.unlock reopens the SSE after teardown", async () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    useEventBusStore.getState().publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    useEventBusStore.getState().publish("power.unlock", {});
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("app.resume no-op (current non-null) does NOT suppress a follow-up power.resume bounce", () => {
    // Real-world trace: tray-resident Electron, system sleeps, wifi
    // reconnects on wake → `online` event → `app.resume(signal:"online")`
    // → handleAppResume runs but bails because `current` is still
    // non-null (renderer never went hidden). 50ms later `power.resume`
    // arrives. The handler MUST bounce — that's the entire point of
    // this PR. Independent dedup windows ensure the noop'd
    // app.resume doesn't suppress it.
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    // Fire app.resume — current is non-null, so this is a no-op.
    useEventBusStore.getState().publish("app.resume", { signal: "online" });
    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    // Power.resume arrives within the dedup window. MUST still bounce.
    useEventBusStore.getState().publish("power.resume", {});
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("app.resume then power.resume — fresh SSE gets bounced (wasted bounce, but the correctness tradeoff)", async () => {
    // Independent dedup windows mean the two handlers don't observe
    // each other's timestamps. In the rare case where the renderer
    // both went hidden AND received a system-power signal on wake,
    // app.resume opens a fresh SSE and power.resume then bounces it.
    // One extra teardown + reopen, <100ms — acceptable cost for
    // closing the missed-bounce bug in the more common tray-resident
    // case.
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    useEventBusStore.getState().publish("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    useEventBusStore.getState().publish("app.resume", { signal: "visibility" });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    useEventBusStore.getState().publish("power.resume", {});
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(3);
    expect(cancelMock).toHaveBeenCalledTimes(2); // app.hidden + power.resume bounce
  }, 5_000);

  test("reachability.retry-requested bounces the SSE connection", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
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
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
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
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT reopen the SSE on app.resume while a connection is still live", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: "asst-1",
        isAssistantActive: true,
      }),
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    useEventBusStore
      .getState()
      .publish("app.resume", { signal: "visibility" });
    // Stream is still open (no app.hidden first), so app.resume only
    // triggers a checkAssistant — no new subscribeChatEvents call.
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT tear down on app.hidden when no connection is live", () => {
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
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
      }),
    );
    window.dispatchEvent(new Event("offline"));
    expect(offlineHandler).toHaveBeenCalledTimes(1);
  });
});

describe("useEventBusInit — deep links", () => {
  test("publishes deeplink.send for live `send` links via the wrapper subscription", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("deeplink.send", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    activeDeepLinkCallback?.({ kind: "send", message: "hi" });

    expect(handler).toHaveBeenCalledWith({ message: "hi" });
  });

  test("publishes deeplink.openThread for live `openThread` links", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("deeplink.openThread", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    activeDeepLinkCallback?.({ kind: "openThread", threadId: "abc" });

    expect(handler).toHaveBeenCalledWith({ threadId: "abc" });
  });

  test("publishes deeplink.unknown for parser-fallback links", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("deeplink.unknown", handler);
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    activeDeepLinkCallback?.({ kind: "unknown", url: "javascript:alert(1)" });

    expect(handler).toHaveBeenCalledWith({ url: "javascript:alert(1)" });
  });

  test("drains the pending buffer at mount and publishes each link in order", async () => {
    const sendHandler = mock(() => {});
    const threadHandler = mock(() => {});
    useEventBusStore.getState().subscribe("deeplink.send", sendHandler);
    useEventBusStore.getState().subscribe("deeplink.openThread", threadHandler);
    pendingDeepLinksFixture = [
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "thread-1" },
    ];

    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    // Drain is awaited; let the microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendHandler).toHaveBeenCalledWith({ message: "one" });
    expect(threadHandler).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  test("subscribes BEFORE draining so a link arriving mid-drain isn't lost", async () => {
    // Trace the subscribe-before-drain order: `subscribeToDeepLinks`
    // must be called before `drainPendingDeepLinks` so a link that
    // lands in the in-flight window between the two calls still
    // reaches the renderer.
    renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    expect(subscribeToDeepLinksMock).toHaveBeenCalled();
    expect(drainPendingDeepLinksMock).toHaveBeenCalled();
    const subscribeOrder =
      subscribeToDeepLinksMock.mock.invocationCallOrder[0]!;
    const drainOrder = drainPendingDeepLinksMock.mock.invocationCallOrder[0]!;
    expect(subscribeOrder).toBeLessThan(drainOrder);
  });

  test("unsubscribes on unmount so live links stop firing into the bus", () => {
    const handler = mock(() => {});
    useEventBusStore.getState().subscribe("deeplink.send", handler);
    const { unmount } = renderHook(() =>
      useEventBusInit({
        assistantId: null,
        isAssistantActive: false,
      }),
    );

    unmount();

    // After unmount, the captured callback is cleared by the
    // unsubscribe-noop returned by `subscribeToDeepLinks`. Verify
    // by attempting to fire — should not deliver.
    activeDeepLinkCallback?.({ kind: "send", message: "post-unmount" });
    expect(handler).not.toHaveBeenCalled();
  });
});
