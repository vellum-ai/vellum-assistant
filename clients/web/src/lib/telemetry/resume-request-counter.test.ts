/**
 * Pins the post-resume request counter's contract:
 *   - one window per foreground, even when iOS publishes two resume signals;
 *   - a backgrounding drops the window instead of emitting a partial sample;
 *   - a window whose timer was frozen while backgrounded is replaced, so the
 *     next foreground gets its own window attributed to its own signal;
 *   - only requests inside the window are counted;
 *   - endpoint labels come from the closed set, never a raw path;
 *   - a zero-count window still emits, and unsubscribe cancels silently.
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

const { publish, __resetForTesting } = await import("@/lib/event-bus");
const {
  __resetResumeRequestCounterForTests,
  isResumeWindowOpen,
  noteDaemonApiRequest,
  subscribeResumeRequestCounter,
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

describe("subscribeResumeRequestCounter", () => {
  test("counts one window across the iOS double-publish", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    publish("app.resume", { signal: "app_state" });

    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/messages");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    const { checkName, value, detail } = lastEmit();
    expect(checkName).toBe("client_resume.request_count");
    expect(value).toBe(2);
    expect(detail.window_ms).toBe(10_000);
    expect(detail.signal).toBe("visibility");
    expect(lastDelay).toBe(10_000);
    unsubscribe();
  });

  test("ignores requests before the window opens and after it closes", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    fireTimers();

    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().value).toBe(1);
    unsubscribe();
  });

  test("drops the window on app.hidden without emitting", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");

    publish("app.hidden", { signal: "app_state" });

    expect(isResumeWindowOpen()).toBe(false);
    expect(pendingTimers.size).toBe(0);
    fireTimers();
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("counts the next foreground after a hidden edge", () => {
    const unsubscribe = subscribeResumeRequestCounter();
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
    unsubscribe();
  });

  test("replaces a window whose timer was frozen while backgrounded", () => {
    const unsubscribe = subscribeResumeRequestCounter();
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
    unsubscribe();
  });

  test("keeps the first window when the second resume lands inside its span", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });

    nowMs = 9_999;
    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/conversations");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().detail.signal).toBe("visibility");
    unsubscribe();
  });

  test("labels endpoints from the closed set and emits no path strings", () => {
    const unsubscribe = subscribeResumeRequestCounter();
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
    unsubscribe();
  });

  test("labels the daemon's high-traffic segments instead of pooling them", () => {
    const unsubscribe = subscribeResumeRequestCounter();
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
    unsubscribe();
  });

  test("emits a zero-count window", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "online" });
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(1);
    expect(lastEmit().value).toBe(0);
    expect(byGroup()).toEqual({});
    unsubscribe();
  });

  test("unsubscribe cancels an open window without emitting", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/messages");

    unsubscribe();
    fireTimers();

    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
    expect(pendingTimers.size).toBe(0);
  });

  test("opens a fresh window on the next resume", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/events");
    fireTimers();

    publish("app.resume", { signal: "app_state" });
    noteDaemonApiRequest("https://api.test/v1/assistants/a1/config");
    fireTimers();

    expect(emitClientPerfEventMock).toHaveBeenCalledTimes(2);
    expect(lastEmit().value).toBe(1);
    expect(byGroup()).toEqual({ config: 1 });
    unsubscribe();
  });
});

describe("noteDaemonApiRequest", () => {
  test("never throws on a malformed url", () => {
    const unsubscribe = subscribeResumeRequestCounter();
    publish("app.resume", { signal: "visibility" });

    expect(() => {
      noteDaemonApiRequest("http://[");
    }).not.toThrow();
    fireTimers();

    expect(lastEmit().value).toBe(1);
    expect(byGroup()).toEqual({ other: 1 });
    unsubscribe();
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

    const unsubscribe = subscribeResumeRequestCounter();
    expect(isResumeWindowOpen()).toBe(false);

    publish("app.resume", { signal: "visibility" });
    expect(isResumeWindowOpen()).toBe(true);

    fireTimers();
    expect(isResumeWindowOpen()).toBe(false);
    unsubscribe();
  });
});
