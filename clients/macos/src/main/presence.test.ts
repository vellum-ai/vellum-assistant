import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `powerMonitor`'s subscriptions are captured by name so the test can fire
// them at will, and `off` removes them so teardown is observable.
type PowerListener = () => void;
const powerListeners = new Map<string, Set<PowerListener>>();
const powerOnMock = mock((event: string, listener: PowerListener) => {
  const existing = powerListeners.get(event) ?? new Set<PowerListener>();
  existing.add(listener);
  powerListeners.set(event, existing);
});
const powerOffMock = mock((event: string, listener: PowerListener) => {
  powerListeners.get(event)?.delete(listener);
});

let idleSeconds = 0;
let idleThrows = false;
const getSystemIdleTimeMock = mock(() => {
  if (idleThrows) {
    throw new Error("idle read failed");
  }
  return idleSeconds;
});

mock.module("electron", () => ({
  powerMonitor: {
    on: powerOnMock,
    off: powerOffMock,
    getSystemIdleTime: getSystemIdleTimeMock,
  },
}));

const { IDLE_THRESHOLD_MS, POLL_INTERVAL_MS, installPresenceMonitor } =
  await import("./presence");

const fire = (event: string): void => {
  for (const listener of powerListeners.get(event) ?? []) {
    listener();
  }
};

const listenerCount = (): number => {
  let total = 0;
  for (const listeners of powerListeners.values()) {
    total += listeners.size;
  }
  return total;
};

// Fake timers so the poll loop is deterministic.
let intervalCallback: (() => void) | null = null;
let intervalDelay: number | null = null;
const clearIntervalMock = mock((_id: unknown) => undefined);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

beforeEach(() => {
  powerListeners.clear();
  powerOnMock.mockClear();
  powerOffMock.mockClear();
  getSystemIdleTimeMock.mockClear();
  idleSeconds = 0;
  idleThrows = false;
  intervalCallback = null;
  intervalDelay = null;
  clearIntervalMock.mockClear();
  globalThis.setInterval = ((cb: () => void, delay: number) => {
    intervalCallback = cb;
    intervalDelay = delay;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval =
    clearIntervalMock as unknown as typeof clearInterval;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("installPresenceMonitor", () => {
  test("reports active when idle time is below the threshold", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = IDLE_THRESHOLD_MS / 1000 - 1;
    intervalCallback?.();

    expect(reports).toEqual(["active"]);
  });

  test("reports idle when idle time reaches the threshold", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = IDLE_THRESHOLD_MS / 1000;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("reports away immediately on lock-screen, ignoring the idle timer", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = 0;
    fire("lock-screen");

    expect(reports).toEqual(["away"]);
  });

  test("reports away immediately on suspend", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = 0;
    fire("suspend");

    expect(reports).toEqual(["away"]);
  });

  test("returns to active on unlock-screen", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = 0;
    fire("lock-screen");
    fire("unlock-screen");

    expect(reports).toEqual(["away", "active"]);
  });

  test("stays away across poll ticks while locked", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    fire("lock-screen");
    intervalCallback?.();

    expect(reports).toEqual(["away", "away"]);
  });

  test("reports on every poll tick even with no state change", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleSeconds = 0;
    intervalCallback?.();
    intervalCallback?.();
    intervalCallback?.();

    expect(reports).toEqual(["active", "active", "active"]);
    expect(intervalDelay).toBe(POLL_INTERVAL_MS);
  });

  test("degrades to idle, never active, when the idle read throws", () => {
    const reports: string[] = [];
    installPresenceMonitor((state) => reports.push(state));

    idleThrows = true;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("teardown clears the interval and detaches every listener", () => {
    const reports: string[] = [];
    const teardown = installPresenceMonitor((state) => reports.push(state));
    expect(listenerCount()).toBe(5);

    teardown();

    expect(clearIntervalMock).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);

    fire("lock-screen");
    expect(reports).toEqual([]);
  });
});
