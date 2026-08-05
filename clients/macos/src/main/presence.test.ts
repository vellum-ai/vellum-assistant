import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `powerMonitor`'s subscriptions are captured by name so the test can fire
// them at will, and `off` removes them so teardown is observable.
type PowerListener = () => void;
const powerListeners = new Map<string, Set<PowerListener>>();
// Set to an event name to make that subscription blow up, standing in for an
// electron build where one of the six events is unavailable.
let attachFailsOn: string | null = null;
const powerOnMock = mock((event: string, listener: PowerListener) => {
  if (event === attachFailsOn) {
    throw new Error(`cannot subscribe to ${event}`);
  }
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

// What the OS itself reports. Defaults to "active" so cases that say nothing
// about it are judged purely on the events and the idle timer.
type SystemIdleState = "active" | "idle" | "locked" | "unknown";
let systemIdleState: SystemIdleState = "active";
let systemIdleStateThrows = false;
const getSystemIdleStateMock = mock((_threshold: number): SystemIdleState => {
  if (systemIdleStateThrows) {
    throw new Error("idle state read failed");
  }
  return systemIdleState;
});

mock.module("electron", () => ({
  powerMonitor: {
    on: powerOnMock,
    off: powerOffMock,
    getSystemIdleTime: getSystemIdleTimeMock,
    getSystemIdleState: getSystemIdleStateMock,
  },
}));

// Stub electron-log so the module's logger import stays inert under test.
const mockLogWarn = mock((..._args: unknown[]) => {});
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: mockLogWarn,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

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
  getSystemIdleStateMock.mockClear();
  mockLogWarn.mockClear();
  attachFailsOn = null;
  idleSeconds = 0;
  idleThrows = false;
  systemIdleState = "active";
  systemIdleStateThrows = false;
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

// The monitor refuses a second install while one is live, so every test has
// to hand its own back before the next one starts.
let activeTeardown: (() => void) | null = null;

afterEach(() => {
  activeTeardown?.();
  activeTeardown = null;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

// Install emits one report straight away; tests that assert on what follows
// drop it so their expectations name only the transitions they exercise.
const install = (): { reports: string[]; teardown: () => void } => {
  const reports: string[] = [];
  const teardown = installPresenceMonitor((state) => reports.push(state));
  activeTeardown = teardown;
  reports.length = 0;
  return { reports, teardown };
};

describe("installPresenceMonitor", () => {
  test("reports once at install, before the first poll tick", () => {
    const reports: string[] = [];
    idleSeconds = 0;
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    expect(reports).toEqual(["active"]);
  });

  test("reports active when idle time is below the threshold", () => {
    const { reports } = install();

    idleSeconds = IDLE_THRESHOLD_MS / 1000 - 1;
    intervalCallback?.();

    expect(reports).toEqual(["active"]);
  });

  test("reports idle when idle time reaches the threshold", () => {
    const { reports } = install();

    idleSeconds = IDLE_THRESHOLD_MS / 1000;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("reports away immediately on lock-screen, ignoring the idle timer", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");

    expect(reports).toEqual(["away"]);
  });

  test("reports away immediately on suspend", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("suspend");

    expect(reports).toEqual(["away"]);
  });

  test("returns to active on unlock-screen", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");
    fire("unlock-screen");

    expect(reports).toEqual(["away", "active"]);
  });

  test("stays away across poll ticks while locked", () => {
    const { reports } = install();

    fire("lock-screen");
    intervalCallback?.();

    expect(reports).toEqual(["away", "away"]);
  });

  test("stays away when a locked machine suspends and resumes", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");
    fire("suspend");
    fire("resume");
    intervalCallback?.();

    expect(reports).toEqual(["away", "away", "away", "away"]);
  });

  test("returns to active once the lock screen clears after a resume", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");
    fire("suspend");
    fire("resume");
    fire("unlock-screen");

    expect(reports).toEqual(["away", "away", "away", "active"]);
  });

  test("stays away when a suspend arrives without a lock", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("suspend");
    intervalCallback?.();
    fire("resume");

    expect(reports).toEqual(["away", "away", "active"]);
  });

  test("reports away when the login session resigns", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("user-did-resign-active");
    intervalCallback?.();
    fire("user-did-become-active");

    expect(reports).toEqual(["away", "away", "active"]);
  });

  test("user-did-become-active does not clear the lock", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");
    fire("user-did-become-active");
    intervalCallback?.();

    expect(reports).toEqual(["away", "away", "away"]);
  });

  test("reports on every poll tick even with no state change", () => {
    const { reports } = install();

    idleSeconds = 0;
    intervalCallback?.();
    intervalCallback?.();
    intervalCallback?.();

    expect(reports).toEqual(["active", "active", "active"]);
    expect(intervalDelay).toBe(POLL_INTERVAL_MS);
  });

  test("degrades to idle, never active, when the idle read throws", () => {
    const { reports } = install();

    idleThrows = true;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("reports away when installed while the OS is already locked", () => {
    // A relaunch behind the lock screen gets no lock-screen event, so nothing
    // but the OS itself can say the banner is unreachable.
    systemIdleState = "locked";
    idleSeconds = 0;
    const reports: string[] = [];
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    intervalCallback?.();

    expect(reports).toEqual(["away", "away"]);
  });

  test("returns to active after unlocking a machine that was locked at install", () => {
    systemIdleState = "locked";
    idleSeconds = 0;
    const reports: string[] = [];
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    systemIdleState = "active";
    fire("unlock-screen");

    expect(reports).toEqual(["away", "active"]);
  });

  test("an unknown OS state never reports active", () => {
    const { reports } = install();

    systemIdleState = "unknown";
    idleSeconds = 0;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("never reports active when the OS state read throws", () => {
    const { reports } = install();

    systemIdleStateThrows = true;
    idleSeconds = 0;
    intervalCallback?.();

    expect(reports).toEqual(["idle"]);
  });

  test("a locked OS state outranks a cleared lock flag", () => {
    const { reports } = install();

    idleSeconds = 0;
    fire("lock-screen");
    systemIdleState = "locked";
    fire("unlock-screen");
    intervalCallback?.();

    expect(reports).toEqual(["away", "away", "away"]);
  });

  test("an idle OS state still reports active below the tuned threshold", () => {
    const { reports } = install();

    // The OS answers against its own threshold; IDLE_THRESHOLD_MS owns the
    // active/idle line here.
    systemIdleState = "idle";
    idleSeconds = IDLE_THRESHOLD_MS / 1000 - 1;
    intervalCallback?.();

    expect(reports).toEqual(["active"]);
  });

  test("a second install while one is live is a no-op", () => {
    const { reports } = install();
    expect(listenerCount()).toBe(6);
    const firstTick = intervalCallback;

    const secondReports: string[] = [];
    const secondTeardown = installPresenceMonitor((state) =>
      secondReports.push(state),
    );

    // No install report, no extra listeners, and the live monitor still owns
    // the poll loop.
    expect(secondReports).toEqual([]);
    expect(listenerCount()).toBe(6);
    expect(intervalCallback).toBe(firstTick);

    idleSeconds = 0;
    intervalCallback?.();
    fire("lock-screen");
    expect(reports).toEqual(["active", "away"]);
    expect(secondReports).toEqual([]);

    // The refused install's teardown owns nothing, so it must not detach the
    // live monitor.
    secondTeardown();
    expect(listenerCount()).toBe(6);
    expect(clearIntervalMock).not.toHaveBeenCalled();
  });

  test("a refused install says so in the log", () => {
    install();

    mockLogWarn.mockClear();
    const secondTeardown = installPresenceMonitor(() => {});

    // A caller that silently gets nothing would otherwise be invisible.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    secondTeardown();
  });

  test("a throw while attaching listeners leaves the latch clear", () => {
    attachFailsOn = "user-did-resign-active";
    expect(() => installPresenceMonitor(() => {})).toThrow();

    // Latching before the listeners are up would strand the process with no
    // monitor, no teardown, and no way to try again.
    attachFailsOn = null;
    idleSeconds = 0;
    const reports: string[] = [];
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    expect(reports).toEqual(["active"]);
    expect(intervalCallback).not.toBeNull();

    fire("lock-screen");
    expect(reports).toEqual(["active", "away"]);
  });

  test("a throw partway through attaching unwinds the earlier listeners", () => {
    const staleReports: string[] = [];
    attachFailsOn = "resume";
    expect(() =>
      installPresenceMonitor((state) => staleReports.push(state)),
    ).toThrow();

    // The three that went up before the failure hold live closures for a
    // monitor nobody has a teardown for, so none of them may survive the call.
    expect(listenerCount()).toBe(0);
    expect(powerOffMock).toHaveBeenCalledTimes(3);
    expect(intervalCallback).toBeNull();

    attachFailsOn = null;
    idleSeconds = 0;
    const reports: string[] = [];
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    // Exactly one set, and the failed install's callback stays silent.
    expect(listenerCount()).toBe(6);
    fire("lock-screen");
    fire("suspend");
    expect(reports).toEqual(["active", "away", "away"]);
    expect(staleReports).toEqual([]);
  });

  test("a fresh install works again after teardown", () => {
    const { teardown } = install();
    teardown();
    expect(listenerCount()).toBe(0);

    idleSeconds = 0;
    const reports: string[] = [];
    activeTeardown = installPresenceMonitor((state) => reports.push(state));

    expect(reports).toEqual(["active"]);
    expect(listenerCount()).toBe(6);
  });

  test("teardown clears the interval and detaches every listener", () => {
    const { reports, teardown } = install();
    expect(listenerCount()).toBe(6);

    teardown();

    expect(clearIntervalMock).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);

    fire("lock-screen");
    fire("user-did-resign-active");
    expect(reports).toEqual([]);
  });
});
