import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserWindow } from "electron";

// `app.on` subscriptions are captured by event name so the test can fire
// them at will, and `BrowserWindow.getAllWindows` returns a controllable
// stub list standing in for the renderer windows that receive the payload.
type Listener = () => void;
const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const appOffMock = mock((event: string, _listener: Listener) => {
  appListeners.delete(event);
});

type SendMock = ReturnType<typeof mock>;
interface StubRenderer {
  isDestroyed: () => boolean;
  webContents: { send: SendMock };
}
let windows: StubRenderer[] = [];

mock.module("electron", () => ({
  app: { on: appOnMock, off: appOffMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const { installWindowAttention } = await import("./window-attention");

const CHANNEL = "vellum:window:attention";

const makeRenderer = (destroyed = false): StubRenderer => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

interface StubMainWindow {
  destroyed: boolean;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  listeners: Map<string, Set<Listener>>;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
  on: (event: string, listener: Listener) => void;
  off: (event: string, listener: Listener) => void;
  emit: (event: string) => void;
}

const makeMainWindow = (): StubMainWindow => {
  const listeners = new Map<string, Set<Listener>>();
  const win: StubMainWindow = {
    destroyed: false,
    visible: true,
    focused: true,
    minimized: false,
    listeners,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isMinimized: () => win.minimized,
    on: (event, listener) => {
      const existing = listeners.get(event) ?? new Set<Listener>();
      existing.add(listener);
      listeners.set(event, existing);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener();
      }
    },
  };
  return win;
};

const install = (win: StubMainWindow | null): (() => void) => {
  return installWindowAttention({
    currentMainWindow: () => win as unknown as BrowserWindow | null,
  });
};

const payloads = (renderer: StubRenderer): unknown[] => {
  return renderer.webContents.send.mock.calls.map((call) => call[1]);
};

beforeEach(() => {
  appListeners.clear();
  appOnMock.mockClear();
  appOffMock.mockClear();
  windows = [];
});

describe("installWindowAttention", () => {
  test("emits the live window state once on install", () => {
    const renderer = makeRenderer();
    windows = [renderer];

    const teardown = install(makeMainWindow());

    expect(renderer.webContents.send).toHaveBeenCalledTimes(1);
    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, {
      visible: true,
      focused: true,
      minimized: false,
    });
    teardown();
  });

  test("emits on browser-window-blur and browser-window-focus", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    main.focused = false;
    appListeners.get("browser-window-blur")?.();
    main.focused = true;
    appListeners.get("browser-window-focus")?.();

    expect(payloads(renderer)).toEqual([
      { visible: true, focused: true, minimized: false },
      { visible: true, focused: false, minimized: false },
      { visible: true, focused: true, minimized: false },
    ]);
    teardown();
  });

  test("emits on the window's own minimize and restore", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    main.minimized = true;
    main.focused = false;
    main.emit("minimize");
    main.minimized = false;
    main.focused = true;
    main.emit("restore");

    expect(payloads(renderer)).toEqual([
      { visible: true, focused: true, minimized: false },
      { visible: true, focused: false, minimized: true },
      { visible: true, focused: true, minimized: false },
    ]);
    teardown();
  });

  test("emits on the window's own hide and show", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    main.visible = false;
    main.focused = false;
    main.emit("hide");
    main.visible = true;
    main.focused = true;
    main.emit("show");

    expect(payloads(renderer)).toEqual([
      { visible: true, focused: true, minimized: false },
      { visible: false, focused: false, minimized: false },
      { visible: true, focused: true, minimized: false },
    ]);
    teardown();
  });

  test("suppresses a duplicate consecutive payload", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    appListeners.get("browser-window-focus")?.();
    appListeners.get("browser-window-focus")?.();
    main.emit("restore");

    expect(renderer.webContents.send).toHaveBeenCalledTimes(1);
    teardown();
  });

  test("reports all false when the accessor returns null", () => {
    const renderer = makeRenderer();
    windows = [renderer];

    const teardown = install(null);

    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, {
      visible: false,
      focused: false,
      minimized: false,
    });
    teardown();
  });

  test("reports all false when the window is destroyed", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    main.destroyed = true;

    const teardown = install(main);

    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, {
      visible: false,
      focused: false,
      minimized: false,
    });
    expect(main.listeners.size).toBe(0);
    teardown();
  });

  test("binds the window once the accessor stops returning null", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    let main: StubMainWindow | null = null;
    const teardown = installWindowAttention({
      currentMainWindow: () => main as unknown as BrowserWindow | null,
    });

    main = makeMainWindow();
    appListeners.get("browser-window-focus")?.();
    main.minimized = true;
    main.focused = false;
    main.emit("minimize");

    expect(payloads(renderer)).toEqual([
      { visible: false, focused: false, minimized: false },
      { visible: true, focused: true, minimized: false },
      { visible: true, focused: false, minimized: true },
    ]);
    teardown();
  });

  test("skips destroyed renderer windows", () => {
    const alive = makeRenderer();
    const dead = makeRenderer(true);
    windows = [alive, dead];

    const teardown = install(makeMainWindow());

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
    teardown();
  });

  test("teardown removes the app and window listeners", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    teardown();

    expect(appOffMock).toHaveBeenCalledTimes(2);
    expect(appListeners.size).toBe(0);
    for (const listeners of main.listeners.values()) {
      expect(listeners.size).toBe(0);
    }

    main.minimized = true;
    main.emit("minimize");
    expect(renderer.webContents.send).toHaveBeenCalledTimes(1);
  });
});
