import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type PowerListener = () => void;

const listeners = new Map<string, Set<PowerListener>>();
const powerOnMock = mock((event: string, listener: PowerListener) => {
  const eventListeners = listeners.get(event) ?? new Set<PowerListener>();
  eventListeners.add(listener);
  listeners.set(event, eventListeners);
});
const powerOffMock = mock((event: string, listener: PowerListener) => {
  listeners.get(event)?.delete(listener);
});

let idleSeconds = 0;
let systemIdleState: "active" | "idle" | "locked" | "unknown" = "active";

mock.module("electron", () => ({
  powerMonitor: {
    on: powerOnMock,
    off: powerOffMock,
    getSystemIdleTime: () => idleSeconds,
    getSystemIdleState: () => systemIdleState,
  },
}));

mock.module("electron-log/main", () => ({
  default: {
    initialize: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    transports: {
      file: {
        maxSize: 0,
        fileName: "",
        format: "",
        getFile: () => ({ path: "" }),
      },
    },
  },
}));

const { IDLE_THRESHOLD_MS, installPresenceMonitor } = await import("./presence");

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let poll: (() => void) | null = null;
let teardown: (() => void) | null = null;

const fire = (event: string): void => {
  for (const listener of listeners.get(event) ?? []) {
    listener();
  }
};

beforeEach(() => {
  listeners.clear();
  idleSeconds = 0;
  systemIdleState = "active";
  poll = null;
  globalThis.setInterval = ((callback: () => void) => {
    poll = callback;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
});

afterEach(() => {
  teardown?.();
  teardown = null;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("Windows desktop presence", () => {
  test("reports active immediately and refreshes the report", () => {
    const reports: string[] = [];
    teardown = installPresenceMonitor((state) => reports.push(state));

    poll?.();

    expect(reports).toEqual(["active", "active"]);
  });

  test("reports away while the screen is locked", () => {
    const reports: string[] = [];
    teardown = installPresenceMonitor((state) => reports.push(state));
    reports.length = 0;

    fire("lock-screen");
    poll?.();

    expect(reports).toEqual(["away", "away"]);
  });

  test("reports idle after the user-attention threshold", () => {
    const reports: string[] = [];
    teardown = installPresenceMonitor((state) => reports.push(state));
    reports.length = 0;

    idleSeconds = IDLE_THRESHOLD_MS / 1000;
    poll?.();

    expect(reports).toEqual(["idle"]);
  });
});
