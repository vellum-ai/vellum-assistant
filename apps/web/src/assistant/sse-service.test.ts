import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import type {
  BusEventName,
  BusEventPayload,
  BusHandler,
  EventBusPublisher,
  EventBusSubscriber,
} from "@/stores/event-bus-store";

type EventHandler = (envelope: AssistantEventEnvelope) => void;
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

const checkAssistantMock = mock(async () => {});
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: checkAssistantMock,
  },
}));

const { sseService } = await import("@/assistant/sse-service");

// In-memory bus stub satisfying `EventBusPublisher & EventBusSubscriber`.
// Each test gets a fresh instance — no module-level state to reset.
const createBusStub = (): EventBusPublisher &
  EventBusSubscriber & {
    publish: ReturnType<typeof mock>;
    handlers: Map<BusEventName, Set<BusHandler<BusEventName>>>;
    fire<K extends BusEventName>(event: K, payload: BusEventPayload<K>): void;
  } => {
  const handlers = new Map<BusEventName, Set<BusHandler<BusEventName>>>();
  const publish = mock(
    <K extends BusEventName>(_event: K, _payload: BusEventPayload<K>) => {},
  );
  const subscribe = <K extends BusEventName>(
    event: K,
    handler: BusHandler<K>,
  ): (() => void) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as BusHandler<BusEventName>);
    return () => {
      handlers.get(event)?.delete(handler as BusHandler<BusEventName>);
    };
  };
  const fire = <K extends BusEventName>(
    event: K,
    payload: BusEventPayload<K>,
  ): void => {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      (handler as BusHandler<K>)(payload);
    }
  };
  return { publish, subscribe, handlers, fire };
};

beforeEach(() => {
  activeOnEvent = null;
  activeOnError = null;
  activeOnReconnect = null;
  lastSubscribeArgs = null;
  cancelMock.mockClear();
  subscribeChatEventsMock.mockClear();
  checkAssistantMock.mockClear();
});

describe("sseService.attach — connection lifecycle", () => {
  test("opens a single unfiltered SSE for the supplied assistantId", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs).toEqual({
      assistantId: "asst-1",
      conversationKey: null,
    });
  });

  test("re-broadcasts every SSE envelope on bus.sse.event", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    const envelope: AssistantEventEnvelope = {
      id: "evt-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "avatar_updated",
        avatarPath: "/tmp/avatar.png",
      },
    };

    activeOnEvent!(envelope);

    expect(bus.publish).toHaveBeenCalledWith("sse.event", envelope);
  });

  test("publishes sse.opened with cause=fresh on first open", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");

    expect(bus.publish).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "fresh",
    });
  });

  test("publishes sse.opened with cause=watchdog when stream reconnects after a watchdog stall", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.publish.mockClear();

    activeOnReconnect!("watchdog");

    expect(bus.publish).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
  });

  test("publishes sse.closed on transport error", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");

    activeOnError!(new Error("network error"));

    expect(bus.publish).toHaveBeenCalledWith("sse.closed", {
      reason: "network error",
    });
  });

  test("detach cancels the SSE", () => {
    const bus = createBusStub();
    const detach = sseService.attach(bus, "asst-1");
    expect(cancelMock).not.toHaveBeenCalled();

    detach();

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("does not publish sse.closed for intentional teardowns (app.hidden, reachability retry)", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.publish.mockClear();

    bus.fire("app.hidden", { signal: "visibility" });
    bus.fire("reachability.retry-requested", {});

    const closedCalls = bus.publish.mock.calls.filter(
      ([name]) => name === "sse.closed",
    );
    expect(closedCalls).toHaveLength(0);
  });
});

describe("sseService.attach — visibility-driven bounce", () => {
  test("tears down on app.hidden and reopens on app.resume after the dedup window", async () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    bus.fire("app.resume", { signal: "visibility" });

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("app.resume inside the dedup window does NOT reopen the SSE", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.fire("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    // Two rapid resumes inside the 1s dedup window — only the first
    // should land a reopen and a checkAssistant call.
    bus.fire("app.resume", { signal: "visibility" });
    bus.fire("app.resume", { signal: "app_state" });

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT reopen the SSE on app.resume while a connection is still live", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("app.resume", { signal: "visibility" });

    // Stream is still open (no app.hidden first), so app.resume only
    // triggers a checkAssistant — no new subscribeChatEvents call.
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("app.resume after app.hidden labels the reopen with cause='resume'", async () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.publish.mockClear();

    bus.fire("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    bus.fire("app.resume", { signal: "visibility" });

    expect(bus.publish).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "resume",
    });
  }, 5_000);
});

describe("sseService.attach — power-driven bounce", () => {
  test("power.suspend tears down a live SSE so the daemon sees us go away cleanly", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("power.suspend", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("power.resume bounces a LIVE SSE (no preceding app.hidden) — the tray-resident case", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(cancelMock).toHaveBeenCalledTimes(0);

    // No app.hidden first — the renderer stayed visible during system
    // sleep (tray-resident / full-screen). power.resume must tear
    // down and reopen, otherwise the half-dead socket persists.
    bus.fire("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("power.unlock bounces a LIVE SSE — screen lock can outlast TCP timeouts", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("power.unlock", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("power.resume reopens the SSE after teardown — same dedup window as app.resume", async () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.fire("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    bus.fire("power.resume", {});

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("power.unlock reopens the SSE after teardown", async () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.fire("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    bus.fire("power.unlock", {});

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("app.resume no-op (current non-null) does NOT suppress a follow-up power.resume bounce", () => {
    // Real-world trace: tray-resident Electron, system sleeps, wifi
    // reconnects on wake → `online` event → `app.resume(signal:"online")`
    // → handleAppResume runs but bails because `current` is still
    // non-null (renderer never went hidden). 50ms later `power.resume`
    // arrives. The handler MUST bounce — that's the entire point of
    // the independent dedup windows.
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("app.resume", { signal: "online" });
    expect(cancelMock).toHaveBeenCalledTimes(0);

    bus.fire("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("app.resume then power.resume — fresh SSE gets bounced (correctness tradeoff)", async () => {
    // Independent dedup windows mean the two handlers don't observe
    // each other's timestamps. In the rare case where the renderer
    // both went hidden AND received a system-power signal on wake,
    // app.resume opens a fresh SSE and power.resume then bounces it.
    // One extra teardown + reopen, <100ms — acceptable cost for
    // closing the missed-bounce bug in the more common tray-resident
    // case.
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.fire("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    bus.fire("app.resume", { signal: "visibility" });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);

    bus.fire("power.resume", {});

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(3);
    expect(cancelMock).toHaveBeenCalledTimes(2);
  }, 5_000);

  test("power.suspend is a no-op when no SSE is open", () => {
    const bus = createBusStub();
    const detach = sseService.attach(bus, "asst-1");
    detach();
    cancelMock.mockClear();

    bus.fire("power.suspend", {});

    expect(cancelMock).not.toHaveBeenCalled();
  });
});

describe("sseService.attach — reachability bounce", () => {
  test("reachability.retry-requested bounces the SSE connection", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    bus.fire("reachability.retry-requested", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("reachability-driven reopen labels sse.opened with cause='error', not 'resume'", () => {
    const bus = createBusStub();
    sseService.attach(bus, "asst-1");
    bus.publish.mockClear();

    bus.fire("reachability.retry-requested", {});

    expect(bus.publish).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "error",
    });
  });
});

describe("sseService.attach — detach cleanup", () => {
  test("detach unsubscribes all bus handlers — events after detach do nothing", () => {
    const bus = createBusStub();
    const detach = sseService.attach(bus, "asst-1");
    detach();
    cancelMock.mockClear();
    subscribeChatEventsMock.mockClear();

    bus.fire("app.hidden", { signal: "visibility" });
    bus.fire("app.resume", { signal: "visibility" });
    bus.fire("power.resume", {});
    bus.fire("power.unlock", {});
    bus.fire("power.suspend", {});
    bus.fire("reachability.retry-requested", {});

    expect(cancelMock).not.toHaveBeenCalled();
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("re-attach after detach gets a fresh dedup window (no leak across sessions)", () => {
    const bus = createBusStub();
    const detach1 = sseService.attach(bus, "asst-1");
    bus.fire("power.resume", {});
    detach1();
    cancelMock.mockClear();
    subscribeChatEventsMock.mockClear();
    checkAssistantMock.mockClear();

    // Fresh attach — the first power.resume should NOT be dedup'd
    // against the previous attach's timestamp.
    sseService.attach(bus, "asst-1");
    bus.fire("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });
});
