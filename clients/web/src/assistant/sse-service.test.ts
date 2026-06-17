import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import * as eventBus from "@/lib/event-bus";
import { requestSseReconnect } from "@/lib/streaming/sse-reconnect-control";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";

type EventHandler = (envelope: AssistantEventEnvelope) => void;
type ReconnectHandler = (cause: "error" | "watchdog") => void;

let activeOnEvent: EventHandler | null = null;
let activeOnError: ((err: Error) => void) | null = null;
let activeOnReconnect: ReconnectHandler | null = null;
let activeOnStreamOpen: (() => void) | null = null;
let activeOnStreamClose: (() => void) | null = null;
let lastSubscribeArgs: {
  assistantId: string;
} | null = null;
const cancelMock = mock(() => {});
const subscribeEventsMock = mock(
  (
    assistantId: string,
    onEvent: EventHandler,
    onError: (err: Error) => void,
    options?: {
      onReconnect?: ReconnectHandler;
      onStreamOpen?: () => void;
      onStreamClose?: () => void;
    },
  ) => {
    lastSubscribeArgs = { assistantId };
    activeOnEvent = onEvent;
    activeOnError = onError;
    activeOnReconnect = options?.onReconnect ?? null;
    activeOnStreamOpen = options?.onStreamOpen ?? null;
    activeOnStreamClose = options?.onStreamClose ?? null;
    return { cancel: cancelMock };
  },
);
mock.module("@/lib/streaming/stream-transport", () => ({
  subscribeEvents: subscribeEventsMock,
}));

const checkAssistantMock = mock(async () => {});
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: checkAssistantMock,
  },
}));

// `seq` is per-assistant, so `attach` clears the resumable cursor to start
// each assistant-scoped stream cold. Spy on the reset to assert that wiring;
// the other exports are stubbed so the module's surface stays complete.
const resetReconnectCursorMock = mock(() => {});
mock.module("@/lib/streaming/reconnect-cursor", () => ({
  getReconnectCursor: () => null,
  advanceReconnectCursor: () => {},
  replaceReconnectCursor: () => {},
  resetReconnectCursor: resetReconnectCursorMock,
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
  activeOnStreamOpen = null;
  activeOnStreamClose = null;
  lastSubscribeArgs = null;
  cancelMock.mockClear();
  subscribeEventsMock.mockClear();
  checkAssistantMock.mockClear();
  resetReconnectCursorMock.mockClear();
  publishSpy.mockClear();
});

describe("sseService.attach — connection lifecycle", () => {
  test("opens a single unfiltered SSE for the supplied assistantId", () => {
    sseService.attach("asst-1");

    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs).toEqual({
      assistantId: "asst-1",
    });
  });

  test("resets the resumable cursor so a switched-to assistant starts cold", () => {
    // GIVEN a prior assistant left a non-null `seq` cursor in the global
    // module state (the cursor is per-assistant and never persisted)
    // WHEN a connection is attached for an assistant
    sseService.attach("asst-2");

    // THEN the cursor is cleared before the first connect, so the stale
    // previous-assistant seq is never sent as `lastSeenSeq` and
    // cold-start anchoring can re-seed it from this assistant's snapshot
    expect(resetReconnectCursorMock).toHaveBeenCalledTimes(1);
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
    // The stream must have genuinely established first — a reconnect only
    // reconciles when there was a live connection to recover.
    activeOnStreamOpen!();
    publishSpy.mockClear();

    activeOnReconnect!("watchdog");

    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "watchdog",
    });
  });

  test("does NOT publish sse.opened on reconnect when the stream never established (502 loop)", () => {
    sseService.attach("asst-1");
    publishSpy.mockClear();

    // Stream never opened (onStreamOpen never fired), then the transport
    // retries. Firing sse.opened here would trigger a full reconcile/refetch
    // with nothing to recover — the source of the request storm.
    activeOnReconnect!("error");
    activeOnReconnect!("error");

    const openedCalls = publishSpy.mock.calls.filter(
      ([name]) => name === "sse.opened",
    );
    expect(openedCalls).toHaveLength(0);
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

  test("bounces the connection with cause=anchor on sse.anchor-requested", () => {
    // GIVEN an attached, open SSE connection
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);
    publishSpy.mockClear();
    cancelMock.mockClear();

    // WHEN cold-start anchoring requests a re-anchor (cursor now seeded at S)
    eventBus.publish("sse.anchor-requested", {});

    // THEN the cursor-less connection is torn down and reopened
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
    // AND the reopen is labeled cause=anchor so reconcile-on-reopen skips a
    // redundant /messages reconcile (the ring replay is the catch-up)
    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "anchor",
    });
  });

  test("ignores sse.anchor-requested when no connection is attached", () => {
    // GIVEN an attached connection that is then detached
    const detach = sseService.attach("asst-1");
    detach();
    subscribeEventsMock.mockClear();
    publishSpy.mockClear();

    // WHEN a re-anchor is requested with nothing attached
    eventBus.publish("sse.anchor-requested", {});

    // THEN nothing reopens — the upcoming cold connect carries the cursor
    expect(subscribeEventsMock).not.toHaveBeenCalled();
    const openedCalls = publishSpy.mock.calls.filter(
      ([name]) => name === "sse.opened",
    );
    expect(openedCalls).toHaveLength(0);
  });
});

// Locks the wire that drives the menu-bar status dot: `deriveAssistantStatus`
// reads `useSSEConnectedStore`, which is meaningless unless the SSE service
// keeps it in sync with the live stream. Connection is mirrored off the
// transport's `onStreamOpen` / `onStreamClose` (genuine establish/end), not
// handle creation — so a failing initial connect and its backoff window read
// as disconnected. Graceful teardowns — which intentionally don't publish
// `sse.closed` — still flip it back to disconnected via the explicit `false`.
describe("sseService.attach — SSE-connected store wiring", () => {
  beforeEach(() => {
    useSSEConnectedStore.setState({ isConnected: false });
  });

  test("does NOT mark the store connected merely on handle creation", () => {
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
    sseService.attach("asst-1");
    // The handle exists but the fetch is still in flight — the store must
    // stay disconnected until the transport reports a genuine open.
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
  });

  test("marks the store connected once the stream genuinely opens", () => {
    sseService.attach("asst-1");
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);

    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);
  });

  test("marks the store disconnected when an established attempt ends (backoff window)", () => {
    sseService.attach("asst-1");
    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);

    activeOnStreamClose!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
  });

  test("re-marks the store connected when a reconnect attempt re-establishes", () => {
    sseService.attach("asst-1");
    activeOnStreamOpen!();
    activeOnStreamClose!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);

    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);
  });

  test("marks the store disconnected on a transport error (retries exhausted)", () => {
    sseService.attach("asst-1");
    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);

    activeOnError!(new Error("network error"));
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
  });

  test("marks the store disconnected on a graceful teardown (app.hidden)", () => {
    sseService.attach("asst-1");
    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);

    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
  });

  test("marks the store disconnected on detach", () => {
    const detach = sseService.attach("asst-1");
    activeOnStreamOpen!();
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);

    detach();
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
  });
});

describe("sseService.attach — visibility-driven bounce", () => {
  test("tears down on app.hidden and reopens on app.resume after the dedup window", async () => {
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("app.resume", { signal: "visibility" });

    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
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

    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT reopen the SSE on app.resume while a connection is still live", () => {
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.resume", { signal: "visibility" });

    // Stream is still open (no app.hidden first), so app.resume only
    // triggers a checkAssistant — no new subscribeEvents call.
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);
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
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

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
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("power.unlock bounces a LIVE SSE — screen lock can outlast TCP timeouts", () => {
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("power.unlock", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
  });

  test("power.resume reopens the SSE after teardown — same dedup window as app.resume", async () => {
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("power.resume", {});

    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("power.unlock reopens the SSE after teardown", async () => {
    sseService.attach("asst-1");
    eventBus.publish("app.hidden", { signal: "visibility" });
    expect(cancelMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    eventBus.publish("power.unlock", {});

    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
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
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("app.resume", { signal: "online" });
    expect(cancelMock).toHaveBeenCalledTimes(0);

    eventBus.publish("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
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
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);

    eventBus.publish("power.resume", {});

    expect(subscribeEventsMock).toHaveBeenCalledTimes(3);
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
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    eventBus.publish("reachability.retry-requested", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
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

describe("sseService.attach — debug-driven reconnect", () => {
  test("reconnectClient with no delay bounces the SSE immediately", () => {
    // GIVEN a live SSE connection
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    // WHEN a debug reconnect is requested with no delay
    const serviced = requestSseReconnect(0);

    // THEN the live connection is torn down and a fresh one opened
    expect(serviced).toBe(true);
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
  });

  test("debug reconnect labels sse.opened with cause='debug'", () => {
    // GIVEN a live SSE connection
    sseService.attach("asst-1");
    publishSpy.mockClear();

    // WHEN a debug reconnect is requested
    requestSseReconnect(0);

    // THEN the reopen is labeled as a debug-triggered reconnect so
    // reconcile consumers (which only skip on "fresh") still fire
    expect(publishSpy).toHaveBeenCalledWith("sse.opened", {
      assistantId: "asst-1",
      cause: "debug",
    });
  });

  test("reconnectClient with a delay disconnects now and reopens after the timeout", async () => {
    // GIVEN a live SSE connection
    sseService.attach("asst-1");
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    // WHEN a debug reconnect is requested with a delay
    requestSseReconnect(50);

    // THEN the connection drops immediately but does not reopen yet
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);

    // AND it reopens once the delay elapses
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
  }, 5_000);

  test("detach cancels a pending delayed reconnect", async () => {
    // GIVEN a live connection with a delayed debug reconnect queued
    const detach = sseService.attach("asst-1");
    requestSseReconnect(1000);
    expect(cancelMock).toHaveBeenCalledTimes(1);
    subscribeEventsMock.mockClear();

    // WHEN the connection is detached before the timer fires
    detach();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // THEN the queued reopen never runs
    expect(subscribeEventsMock).not.toHaveBeenCalled();
  });

  test("reconnectClient is a no-op after detach (no live connection)", () => {
    // GIVEN a connection that has already been detached
    const detach = sseService.attach("asst-1");
    detach();
    subscribeEventsMock.mockClear();

    // WHEN a debug reconnect is requested
    const serviced = requestSseReconnect(0);

    // THEN nothing services it and no connection is opened
    expect(serviced).toBe(false);
    expect(subscribeEventsMock).not.toHaveBeenCalled();
  });
});

describe("sseService.attach — detach cleanup", () => {
  test("detach unsubscribes all bus handlers — events after detach do nothing", () => {
    const detach = sseService.attach("asst-1");
    detach();
    cancelMock.mockClear();
    subscribeEventsMock.mockClear();

    eventBus.publish("app.hidden", { signal: "visibility" });
    eventBus.publish("app.resume", { signal: "visibility" });
    eventBus.publish("power.resume", {});
    eventBus.publish("power.unlock", {});
    eventBus.publish("power.suspend", {});
    eventBus.publish("reachability.retry-requested", {});

    expect(cancelMock).not.toHaveBeenCalled();
    expect(subscribeEventsMock).not.toHaveBeenCalled();
  });

  test("re-attach after detach gets a fresh dedup window (no leak across sessions)", () => {
    const detach1 = sseService.attach("asst-1");
    eventBus.publish("power.resume", {});
    detach1();
    cancelMock.mockClear();
    subscribeEventsMock.mockClear();
    checkAssistantMock.mockClear();

    // Fresh attach — the first power.resume should NOT be dedup'd
    // against the previous attach's timestamp.
    sseService.attach("asst-1");
    eventBus.publish("power.resume", {});

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(subscribeEventsMock).toHaveBeenCalledTimes(2);
    expect(checkAssistantMock).toHaveBeenCalledTimes(1);
  });
});
