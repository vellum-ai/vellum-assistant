import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import * as eventBus from "@/lib/event-bus";

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

// The real bus has the pub/sub semantics we need to exercise — no
// reason to maintain a parallel mock. `__resetForTesting` gives
// each test a clean handler registry; `spyOn` on the module
// namespace records `publish` calls without shadowing the real
// implementation.
const publishSpy = spyOn(eventBus, "publish");

beforeEach(() => {
  eventBus.__resetForTesting();
  activeOnEvent = null;
  activeOnError = null;
  activeOnReconnect = null;
  lastSubscribeArgs = null;
  cancelMock.mockClear();
  subscribeChatEventsMock.mockClear();
  checkAssistantMock.mockClear();
  publishSpy.mockClear();
});

describe("sseService.attach — connection lifecycle", () => {
  test("opens a single unfiltered SSE for the supplied assistantId", () => {
    sseService.attach("asst-1");

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs).toEqual({
      assistantId: "asst-1",
      conversationKey: null,
    });
  });

  test("re-broadcasts every SSE envelope on bus.sse.event", () => {
    sseService.attach("asst-1");
    const envelope: AssistantEventEnvelope = {
      id: "evt-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "avatar_updated",
        avatarPath: "/tmp/avatar.png",
      },
    };

    activeOnEvent!(envelope);

    expect(publishSpy).toHaveBeenCalledWith("sse.event", envelope);
  });

  test("publishes sse.opened with cause=fresh on first open", () => {
    sseService.attach("asst-1");

    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "fresh",
    });
  });

  test("publishes sse.opened with cause=watchdog when stream reconnects after a watchdog stall", () => {
    sseService.attach("asst-1");
    publishSpy.mockClear();

    activeOnReconnect!("watchdog");

    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
  });

  test("publishes sse.closed on transport error", () => {
    sseService.attach("asst-1");

    activeOnError!(new Error("network error"));

    expect(publishSpy).toHaveBeenCalledWith("sse.closed", {
      reason: "network error",
    });
  });

  test("detach cancels the SSE", () => {
    const detach = sseService.attach("asst-1");
    expect(cancelMock).not.toHaveBeenCalled();

    detach();

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("does not publish sse.closed for intentional teardowns (app.hidden, reachability retry)", () => {
    sseService.attach("asst-1");
    publishSpy.mockClear();

    eventBus.publish("app.hidden", { signal: "visibility" });
    eventBus.publish("reachability.retry-requested", {});

    const closedCalls = publishSpy.mock.calls.filter(
      ([name]) => name === "sse.closed",
    );
    expect(closedCalls).toHaveLength(0);
  });
});

describe("sseService.attach — visibility-driven bounce", () => {
  test("tears down on app.hidden and reopens on app.resume after the dedup window", async () => {
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("app.resume", { signal: "visibility" });

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("app.resume inside the dedup window does NOT reopen the SSE", () => {
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    // Two rapid resumes inside the 1s dedup window — only the first
    // should land a reopen and a checkAssistant call.
    eventBus.publish("app.resume", { signal: "visibility" });
    eventBus.publish("app.resume", { signal: "app_state" });

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT reopen the SSE on app.resume while a connection is still live", () => {
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.resume", { signal: "visibility" });

    // Stream is still open (no app.hidden first), so app.resume only
    // triggers a checkAssistant — no new subscribeChatEvents call.
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("app.resume after app.hidden labels the reopen with cause='resume'", async () => {
    sseService.attach("asst-1");
    publishSpy.mockClear();

    eventBus.publish("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("app.resume", { signal: "visibility" });

    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "resume",
    });
  }, 5_000);
});

describe("sseService.attach — power-driven bounce", () => {
  test("power.suspend tears down a live SSE so the daemon sees us go away cleanly", () => {
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("power.suspend", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("power.resume bounces a LIVE SSE (no preceding app.hidden) — the tray-resident case", () => {
    sseService.attach("asst-1");
    expect(cancelMock).toHaveBeenCalledTimes(0);

    // No app.hidden first — the renderer stayed visible during system
    // sleep (tray-resident / full-screen). power.resume must tear
    // down and reopen, otherwise the half-dead socket persists.
    eventBus.publish("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("power.unlock bounces a LIVE SSE — screen lock can outlast TCP timeouts", () => {
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("power.unlock", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("power.resume reopens the SSE after teardown — same dedup window as app.resume", async () => {
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("power.resume", {});

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("power.unlock reopens the SSE after teardown", async () => {
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("power.unlock", {});

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
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.resume", { signal: "online" });
    expect(cancelMock).toHaveBeenCalledTimes(0);

    eventBus.publish("power.resume", {});

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
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("app.resume", { signal: "visibility" });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);

    eventBus.publish("power.resume", {});

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(3);
    expect(cancelMock).toHaveBeenCalledTimes(2);
  }, 5_000);

  test("power.suspend is a no-op when no SSE is open", () => {
    const detach = sseService.attach("asst-1");
    detach();
    cancelMock.mockClear();

    eventBus.publish("power.suspend", {});

    expect(cancelMock).not.toHaveBeenCalled();
  });
});

describe("sseService.attach — reachability bounce", () => {
  test("reachability.retry-requested bounces the SSE connection", () => {
    sseService.attach("asst-1");
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("reachability.retry-requested", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
  });

  test("reachability-driven reopen labels sse.opened with cause='error', not 'resume'", () => {
    sseService.attach("asst-1");
    publishSpy.mockClear();

    eventBus.publish("reachability.retry-requested", {});

    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "error",
    });
  });
});

describe("sseService.attach — detach cleanup", () => {
  test("detach unsubscribes all bus handlers — events after detach do nothing", () => {
    const detach = sseService.attach("asst-1");
    detach();
    cancelMock.mockClear();
    subscribeChatEventsMock.mockClear();

    eventBus.publish("app.hidden", { signal: "visibility" });
    eventBus.publish("app.resume", { signal: "visibility" });
    eventBus.publish("power.resume", {});
    eventBus.publish("power.unlock", {});
    eventBus.publish("power.suspend", {});
    eventBus.publish("reachability.retry-requested", {});

    expect(cancelMock).not.toHaveBeenCalled();
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("re-attach after detach gets a fresh dedup window (no leak across sessions)", () => {
    const detach1 = sseService.attach("asst-1");
    eventBus.publish("power.resume", {});
    detach1();
    cancelMock.mockClear();
    subscribeChatEventsMock.mockClear();
    checkAssistantMock.mockClear();

    // Fresh attach — the first power.resume should NOT be dedup'd
    // against the previous attach's timestamp.
    sseService.attach("asst-1");
    eventBus.publish("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });
});
