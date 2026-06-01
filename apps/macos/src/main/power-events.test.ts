import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// `powerMonitor`'s subscriptions are captured by name so the test can
// fire them at will. `BrowserWindow.getAllWindows` returns a controllable
// stub list. `app.on("before-quit", ...)` is captured the same way.
type PowerListener = () => void;
const powerListeners = new Map<string, PowerListener>();
const powerOnMock = mock((event: string, listener: PowerListener) => {
  powerListeners.set(event, listener);
});

type SendMock = ReturnType<typeof mock>;
interface StubWindow {
  isDestroyed: () => boolean;
  webContents: { send: SendMock };
}
let windows: StubWindow[] = [];

const appOnMock = mock((_event: string, _handler: () => void) => undefined);

mock.module("electron", () => ({
  powerMonitor: { on: powerOnMock },
  BrowserWindow: { getAllWindows: () => windows },
  app: { on: appOnMock },
}));

const { __resetForTesting, installPowerEvents } = await import(
  "./power-events"
);

const makeWindow = (destroyed = false): StubWindow => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

beforeEach(() => {
  __resetForTesting();
  powerListeners.clear();
  powerOnMock.mockClear();
  appOnMock.mockClear();
  windows = [];
});

afterEach(() => {
  windows = [];
});

describe("installPowerEvents", () => {
  test("subscribes to suspend, resume, lock-screen, unlock-screen, user-did-become-active", () => {
    installPowerEvents();
    expect(powerListeners.has("suspend")).toBe(true);
    expect(powerListeners.has("resume")).toBe(true);
    expect(powerListeners.has("lock-screen")).toBe(true);
    expect(powerListeners.has("unlock-screen")).toBe(true);
    expect(powerListeners.has("user-did-become-active")).toBe(true);
  });

  test("is idempotent — repeated calls don't re-subscribe", () => {
    installPowerEvents();
    installPowerEvents();
    installPowerEvents();
    // Five distinct events, three install attempts; only the first
    // wires through to powerMonitor.on, total 5 calls.
    expect(powerOnMock).toHaveBeenCalledTimes(5);
  });
});

describe("broadcast", () => {
  test("forwards a kind-discriminated payload to every BrowserWindow's webContents", () => {
    installPowerEvents();
    const w1 = makeWindow();
    const w2 = makeWindow();
    windows = [w1, w2];

    powerListeners.get("suspend")?.();

    expect(w1.webContents.send).toHaveBeenCalledWith("vellum:power:event", {
      kind: "suspend",
    });
    expect(w2.webContents.send).toHaveBeenCalledWith("vellum:power:event", {
      kind: "suspend",
    });
  });

  test("maps Electron's lock-screen / unlock-screen / user-did-become-active to lock/unlock/active", () => {
    installPowerEvents();
    const w = makeWindow();
    windows = [w];

    powerListeners.get("lock-screen")?.();
    powerListeners.get("unlock-screen")?.();
    powerListeners.get("user-did-become-active")?.();

    expect(w.webContents.send.mock.calls.map((c) => c[1])).toEqual([
      { kind: "lock" },
      { kind: "unlock" },
      { kind: "active" },
    ]);
  });

  test("skips destroyed windows", () => {
    installPowerEvents();
    const alive = makeWindow();
    const dead = makeWindow(true);
    windows = [alive, dead];

    powerListeners.get("resume")?.();

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  test("debounces duplicate events of the same kind within 1s", () => {
    installPowerEvents();
    const w = makeWindow();
    windows = [w];

    powerListeners.get("resume")?.();
    powerListeners.get("resume")?.();
    powerListeners.get("resume")?.();

    expect(w.webContents.send).toHaveBeenCalledTimes(1);
  });

  test("does NOT debounce across kinds — suspend and resume both fire", () => {
    installPowerEvents();
    const w = makeWindow();
    windows = [w];

    powerListeners.get("suspend")?.();
    powerListeners.get("resume")?.();

    expect(w.webContents.send.mock.calls.map((c) => c[1])).toEqual([
      { kind: "suspend" },
      { kind: "resume" },
    ]);
  });
});
