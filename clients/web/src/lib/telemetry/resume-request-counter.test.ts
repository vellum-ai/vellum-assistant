/**
 * Pins the post-resume request counter's contract:
 *   - one window per foreground, even when iOS publishes two resume signals;
 *   - a backgrounding drops the window instead of emitting a partial sample;
 *   - a window whose timer was frozen while suspended is replaced on the next
 *     resume, and discarded outright when the frozen timer thaws first;
 *   - requests a later-registered resume subscriber fires synchronously are
 *     counted, which is what installing at module scope buys;
 *   - only requests inside the window are counted;
 *   - an emitted window reports the span it actually covered alongside the
 *     span it was scheduled for;
 *   - endpoint labels come from the closed set, never a raw path;
 *   - a zero-count window still emits.
 *
 * bun:test has no fake-timer API, so `setTimeout` / `clearTimeout` are swapped
 * for a capturing stub and fired by hand, the same idiom
 * `use-feature-flag-bus-sync.test.tsx` uses. `performance.now` is stubbed the
 * same way so the frozen-timer case can be reproduced without waiting.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const emitClientPerfEventMock = mock(
  (_checkName: string, _value: number, _detail?: Record<string, unknown>) => {},
);

// Module mocks are process-wide, so this stands in for client-perf in every
// test file that shares the process. Mirror its full export surface.
mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: emitClientPerfEventMock,
  setClientPerfBootId: () => {},
  __resetClientPerfForTests: () => {},
}));

const { publish, subscribe, __resetForTesting } = await import(
  "@/lib/event-bus"
);
const {
  __resetResumeRequestCounterForTests,
  installResumeRequestCounter,
  isResumeWindowOpen,
  noteDaemonApiRequest,
} = await import("./resume-request-counter");

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalPerformanceNow = performance.now.bind(performance);

let pendingTimers = new Map<number, () => void>();
let nextTimerId = 1;
let lastDelay: number | undefined;
let nowMs = 0;

function fireTimers(): void {
  const callbacks = Array.from(pendingTimers.values());
  pendingTimers.clear();
  for (const callback of callbacks) {
    callback();
  }
}

function lastEmit(): {
  checkName: string;
  value: number;
  detail: Record<string, unknown>;
} {
  const call = emitClientPerfEventMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return {
    checkName: call![0],
    value: call![1],
    detail: (call![2] ?? {}) as Record<string, unknown>,
  };
}

function byGroup(): Record<string, number> {
  return lastEmit().detail.by_group as Record<string, number>;
}

beforeEach(() => {
  pendingTimers = new Map();
  nextTimerId = 1;
  lastDelay = undefined;
  nowMs = 0;
  performance.now = () => nowMs;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = nextTimerId++;
    lastDelay = delay;
    if (typeof callback === "function") {
      pendingTimers.set(id, () => {
        callback();
      });
    }
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) {
      pendingTimers.delete(id);
    }
  }) as unknown as typeof clearTimeout;
  emitClientPerfEventMock.mockClear();
  __resetForTesting();
  __resetResumeRequestCounterForTests();
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  performance.now = originalPerformanceNow;
});

describe("installResumeRequestCounter", () => {
  test("counts one window across the iOS double-publish", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    publish("app.resume", { signal: "app_state" });

    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/messages");
    // A healthy timer fires at the end of the span it was scheduled for.
    nowMs = 10_000;
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    const { checkName, value, detail } = lastEmit();
    expect(checkName).toBe("client_resume.request_count");
    expect(value).toBe(2);
    expect(detail.window_ms).toBe(10_000);
    expect(typeof detail.observed_window_ms).toBe("number");
    expect(detail.observed_window_ms).toBe(10_000);
    expect(detail.signal).toBe("visibility");
    expect(lastDelay).toBe(10_000);
  });

  test("reports the span a mildly thawed window actually covered", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    // A short stall thaws inside the guard's 2x threshold, so the sample is
    // kept and its real age rides along for downstream filtering.
    nowMs = 15_500;
    fireTimers();

    const { value, detail } = lastEmit();
    expect(value).toBe(1);
    expect(detail.window_ms).toBe(10_000);
    expect(detail.observed_window_ms).toBe(15_500);
  });

  test("counts requests a later-registered resume handler fires synchronously", () => {
    installResumeRequestCounter();
    // Stands in for a subscriber the React tree registers (the timezone sync,
    // the runtime-upgrade banner): it fires daemon requests synchronously from
    // inside its own `app.resume` handler. Production guarantees this ordering
    // by installing the counter from module scope, before React mounts.
    const unsubscribeSubscriber = subscribe("app.resume", () => {
      noteDaemonApiRequest("https://api.test/v1/assistants/a1/config");
      noteDaemonApiRequest("https://api.test/v1/assistants/a1/home");
    });

    publish("app.resume", { signal: "app_state" });
    fireTimers();

    expect(lastEmit().value).toBe(2);
    expect(byGroup()).toEqual({ config: 1, home: 1 });
    unsubscribeSubscriber();
  });

  test("a resume handler registered before the counter is not counted", () => {
    // The bus dispatches in registration order, so this is the ordering the
    // counter has to beat: the head of the burst is gone before the window
    // opens. Pins why the install happens at module scope rather than from a
    // React effect, which descendant subscribers would run ahead of.
    const unsubscribeSubscriber = subscribe("app.resume", () => {
      noteDaemonApiRequest("https://api.test/v1/assistants/a1/config");
    });
    installResumeRequestCounter();

    publish("app.resume", { signal: "app_state" });
    fireTimers();

    expect(lastEmit().value).toBe(0);
    unsubscribeSubscriber();
  });

  test("ignores requests before the window opens and after it closes", () => {
    installResumeRequestCounter();
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    fireTimers();

    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().value).toBe(1);
  });

  test("drops the window on app.hidden without emitting", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    publish("app.hidden", { signal: "app_state" });

    expect(isResumeWindowOpen()).toBe(false);
    expect(pendingTimers.size).toBe(0);
    fireTimers();
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
  });

  test("counts the next foreground after a hidden edge", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    publish("app.hidden", { signal: "visibility" });

    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/skills");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().value).toBe(1);
    expect(lastEmit().detail.signal).toBe("app_state");
    expect(byGroup()).toEqual({ skills: 1 });
  });

  test("replaces a window whose timer was frozen while backgrounded", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    // WKWebView suspends timers in the background, so the 10s timer is still
    // pending a minute later when the app foregrounds again.
    nowMs = 60_000;
    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/integrations");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    const { value, detail } = lastEmit();
    expect(value).toBe(1);
    expect(detail.signal).toBe("app_state");
    expect(byGroup()).toEqual({ integrations: 1 });
  });

  test("drops a window whose frozen timer thaws long after its span", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    // Desktop system sleep with a focused tab fires no visibilitychange, so
    // nothing cancels the window; the timer freezes and thaws minutes later,
    // with counts spanning the whole sleep rather than the labelled 10s.
    nowMs = 300_000;
    fireTimers();

    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
    expect(isResumeWindowOpen()).toBe(false);
  });

  test("keeps the first window when the second resume lands inside its span", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });

    nowMs = 9_999;
    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().detail.signal).toBe("visibility");
  });

  test("labels endpoints from the closed set and emits no path strings", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "app_state" });

    noteDaemonApiRequest("/v1/assistants/x/conversations?limit=50");
    noteDaemonApiRequest("https://api.test/v1/feature-flags");
    noteDaemonApiRequest("https://api.test/v1/assistants/x/frobnicate");
    fireTimers();

    expect(byGroup()).toEqual({
      conversations: 1,
      "feature-flags": 1,
      other: 1,
    });
    const serialized = JSON.stringify(lastEmit().detail);
    expect(serialized).not.toContain("assistants");
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("frobnicate");
  });

  test("labels the daemon's high-traffic segments instead of pooling them", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "app_state" });

    noteDaemonApiRequest("https://api.test/v1/assistants/a1/integrations");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/skills/some-skill");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/inference/models");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/subagents");
    noteDaemonApiRequest("https://api.test/v1/heartbeat");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/disk-pressure");
    fireTimers();

    expect(byGroup()).toEqual({
      integrations: 1,
      skills: 1,
      inference: 1,
      subagents: 1,
      heartbeat: 1,
      "disk-pressure": 1,
    });
    for (const count of Object.values(byGroup())) {
      expect(typeof count).toBe("number");
    }
  });

  test("emits a zero-count window", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "online" });
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().value).toBe(0);
    expect(byGroup()).toEqual({});
  });

  test("opens a fresh window on the next resume", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/events");
    fireTimers();

    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/config");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(2);
    expect(lastEmit().value).toBe(1);
    expect(byGroup()).toEqual({ config: 1 });
  });
});

describe("noteDaemonApiRequest", () => {
  test("never throws on a malformed url", () => {
    installResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });

    expect(() => {
      noteDaemonApiRequest("http://[");
    }).not.toThrow();
    fireTimers();

    expect(lastEmit().value).toBe(1);
    expect(byGroup()).toEqual({ other: 1 });
  });

  test("is a no-op outside a window", () => {
    expect(() => {
      noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    }).not.toThrow();
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
  });
});

describe("isResumeWindowOpen", () => {
  test("tracks the window so callers can skip work on the request path", () => {
    expect(isResumeWindowOpen()).toBe(false);

    installResumeRequestCounter();
    expect(isResumeWindowOpen()).toBe(false);

    publish("app.resume", { signal: "visibility" });
    expect(isResumeWindowOpen()).toBe(true);

    fireTimers();
    expect(isResumeWindowOpen()).toBe(false);
  });
});
