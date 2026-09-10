import { afterEach, describe, expect, jest, test } from "bun:test";

import { createIdleWatchdog, DEFAULT_SSE_IDLE_TIMEOUT_MS } from "../sse-idle-watchdog.js";

describe("createIdleWatchdog", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("DEFAULT_SSE_IDLE_TIMEOUT_MS is 45s", () => {
    expect(DEFAULT_SSE_IDLE_TIMEOUT_MS).toBe(45_000);
  });

  test("aborts the controller after idleTimeoutMs with no traffic", () => {
    jest.useFakeTimers();
    const watchdog = createIdleWatchdog({ idleTimeoutMs: 1_000 });
    const controller = new AbortController();

    watchdog.arm(controller, 0);
    expect(controller.signal.aborted).toBe(false);

    jest.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false);

    jest.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(watchdog.consumeLastAbortCause()).toBe("watchdog");
  });

  test("recordTraffic + arm resets the idle deadline", () => {
    jest.useFakeTimers();
    const watchdog = createIdleWatchdog({ idleTimeoutMs: 1_000 });
    const controller = new AbortController();

    watchdog.arm(controller, 0);
    jest.advanceTimersByTime(900);
    watchdog.recordTraffic(false);
    watchdog.arm(controller, 0);
    jest.advanceTimersByTime(900);
    expect(controller.signal.aborted).toBe(false);

    jest.advanceTimersByTime(100);
    expect(controller.signal.aborted).toBe(true);
  });

  test("clear prevents a pending timer from aborting", () => {
    jest.useFakeTimers();
    const watchdog = createIdleWatchdog({ idleTimeoutMs: 1_000 });
    const controller = new AbortController();

    watchdog.arm(controller, 0);
    watchdog.clear();
    jest.advanceTimersByTime(5_000);
    expect(controller.signal.aborted).toBe(false);
    expect(watchdog.consumeLastAbortCause()).toBeNull();
  });

  test("consumeLastAbortCause is one-shot", () => {
    jest.useFakeTimers();
    const watchdog = createIdleWatchdog({ idleTimeoutMs: 10 });
    const controller = new AbortController();

    watchdog.arm(controller, 2);
    jest.advanceTimersByTime(10);
    expect(watchdog.consumeLastAbortCause()).toBe("watchdog");
    expect(watchdog.consumeLastAbortCause()).toBeNull();
  });

  test("onFire receives counters and lastByteAgeMs is null when no traffic arrived", () => {
    jest.useFakeTimers();
    const fires: Array<{
      attempt: number;
      lastByteAgeMs: number | null;
      keepalivesReceivedSinceConnect: number;
      dataFramesReceivedSinceConnect: number;
    }> = [];
    const watchdog = createIdleWatchdog({
      idleTimeoutMs: 50,
      onFire: (info) => {
        fires.push(info);
      },
    });
    const controller = new AbortController();

    watchdog.arm(controller, 3);
    jest.advanceTimersByTime(50);

    expect(fires.length).toBe(1);
    expect(fires[0]?.attempt).toBe(3);
    expect(fires[0]?.lastByteAgeMs).toBeNull();
    expect(fires[0]?.keepalivesReceivedSinceConnect).toBe(0);
    expect(fires[0]?.dataFramesReceivedSinceConnect).toBe(0);
  });

  test("onFire reports keepalive vs data counters after traffic", () => {
    jest.useFakeTimers();
    let lastByteAgeMs: number | null = null;
    let keepalives = -1;
    let dataFrames = -1;
    const watchdog = createIdleWatchdog({
      idleTimeoutMs: 100,
      onFire: (info) => {
        lastByteAgeMs = info.lastByteAgeMs;
        keepalives = info.keepalivesReceivedSinceConnect;
        dataFrames = info.dataFramesReceivedSinceConnect;
      },
    });
    const controller = new AbortController();

    watchdog.recordTraffic(false);
    watchdog.recordTraffic(false);
    watchdog.recordTraffic(true);
    watchdog.arm(controller, 0);
    jest.advanceTimersByTime(100);

    expect(keepalives).toBe(2);
    expect(dataFrames).toBe(1);
    expect(lastByteAgeMs).toBeGreaterThanOrEqual(100);
  });

  test("onFire throw does not prevent abort", () => {
    jest.useFakeTimers();
    const watchdog = createIdleWatchdog({
      idleTimeoutMs: 10,
      onFire: () => {
        throw new Error("telemetry exploded");
      },
    });
    const controller = new AbortController();

    watchdog.arm(controller, 0);
    jest.advanceTimersByTime(10);
    expect(controller.signal.aborted).toBe(true);
    expect(watchdog.consumeLastAbortCause()).toBe("watchdog");
  });

  test("resetCounters clears liveness stats for the next attempt", () => {
    jest.useFakeTimers();
    let keepalives = -1;
    const watchdog = createIdleWatchdog({
      idleTimeoutMs: 10,
      onFire: (info) => {
        keepalives = info.keepalivesReceivedSinceConnect;
      },
    });

    watchdog.recordTraffic(false);
    watchdog.resetCounters();
    const controller = new AbortController();
    watchdog.arm(controller, 0);
    jest.advanceTimersByTime(10);
    expect(keepalives).toBe(0);
  });
});
