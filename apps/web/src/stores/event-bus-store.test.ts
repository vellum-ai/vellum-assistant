import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

function avatarEvent(): AssistantEvent {
  return { type: "avatar_updated" } as AssistantEvent;
}

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  __resetEventBusForTesting();
});

describe("event-bus-store", () => {
  test("publish delivers to a single subscriber", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    bus.subscribe("sse.event", handler);
    const event = avatarEvent();
    bus.publish("sse.event", event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  test("publish delivers to every active subscriber", () => {
    const bus = useEventBusStore.getState();
    const a = mock(() => {});
    const b = mock(() => {});
    bus.subscribe("app.online", a);
    bus.subscribe("app.online", b);
    bus.publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe stops delivery to that subscriber", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    const unsubscribe = bus.subscribe("sse.event", handler);
    bus.publish("sse.event", avatarEvent());
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    bus.publish("sse.event", avatarEvent());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe is safe to call twice", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    const unsubscribe = bus.subscribe("app.offline", handler);
    unsubscribe();
    unsubscribe();
    bus.publish("app.offline", {});
    expect(handler).not.toHaveBeenCalled();
  });

  test("subscribers on different event names are isolated", () => {
    const bus = useEventBusStore.getState();
    const sseHandler = mock(() => {});
    const resumeHandler = mock(() => {});
    bus.subscribe("sse.event", sseHandler);
    bus.subscribe("app.resume", resumeHandler);
    bus.publish("app.resume", { signal: "visibility" });
    expect(sseHandler).not.toHaveBeenCalled();
    expect(resumeHandler).toHaveBeenCalledTimes(1);
  });

  test("publish with no subscribers is a no-op", () => {
    const bus = useEventBusStore.getState();
    expect(() => bus.publish("app.resume", { signal: "online" })).not.toThrow();
  });

  test("a throwing handler does not block downstream handlers", () => {
    const bus = useEventBusStore.getState();
    const bad = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    bus.subscribe("app.online", bad);
    bus.subscribe("app.online", good);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      bus.publish("app.online", {});
    } finally {
      console.error = originalConsoleError;
    }
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing during dispatch does not skip remaining handlers", () => {
    const bus = useEventBusStore.getState();
    const a = mock(() => {});
    const c = mock(() => {});
    let unsubB: (() => void) | null = null;
    const b = mock(() => {
      unsubB?.();
    });
    bus.subscribe("app.online", a);
    unsubB = bus.subscribe("app.online", b);
    bus.subscribe("app.online", c);
    bus.publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    bus.publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(2);
  });

  test("sse.opened payload is typed and delivered to subscribers", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    bus.subscribe("sse.opened", handler);
    bus.publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });
    expect(handler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "fresh",
    });
  });

  test("sse.closed payload is typed and delivered to subscribers", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    bus.subscribe("sse.closed", handler);
    bus.publish("sse.closed", { reason: "network error" });
    expect(handler).toHaveBeenCalledWith({ reason: "network error" });
  });

  test("reachability.retry-requested is delivered to subscribers", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    bus.subscribe("reachability.retry-requested", handler);
    bus.publish("reachability.retry-requested", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("__resetEventBusForTesting clears every subscriber", () => {
    const bus = useEventBusStore.getState();
    const handler = mock(() => {});
    bus.subscribe("app.online", handler);
    __resetEventBusForTesting();
    bus.publish("app.online", {});
    expect(handler).not.toHaveBeenCalled();
  });
});
