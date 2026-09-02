import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserWindow } from "electron";

// `app.on` subscriptions are captured by event name so the test can fire
// them at will, and `BrowserWindow.getAllWindows` returns a controllable
// stub list standing in for the renderer windows that receive the payload.
type Listener = (...args: unknown[]) => void;
const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const appOffMock = mock((event: string, _listener: Listener) => {
  appListeners.delete(event);
});

type SendMock = ReturnType<typeof mock>;

interface StubEmitter {
  listeners: Map<string, Set<Listener>>;
  on: (event: string, listener: Listener) => void;
  once: (event: string, listener: Listener) => void;
  off: (event: string, listener: Listener) => void;
  emit: (event: string) => void;
  listenerCount: (event: string) => number;
}

const makeEmitter = (): StubEmitter => {
  const listeners = new Map<string, Set<Listener>>();
  const onceListeners = new Set<Listener>();
  return {
    listeners,
    on: (event, listener) => {
      const existing = listeners.get(event) ?? new Set<Listener>();
      existing.add(listener);
      listeners.set(event, existing);
    },
    once: (event, listener) => {
      onceListeners.add(listener);
      const existing = listeners.get(event) ?? new Set<Listener>();
      existing.add(listener);
      listeners.set(event, existing);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
      onceListeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        if (onceListeners.has(listener)) {
          onceListeners.delete(listener);
          listeners.get(event)?.delete(listener);
        }
        listener();
      }
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
};

interface StubWebContents extends StubEmitter {
  destroyed: boolean;
  isDestroyed: () => boolean;
  send: SendMock;
}

interface StubRenderer {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: StubWebContents;
}

let windows: StubRenderer[] = [];

mock.module("electron", () => ({
  app: { on: appOnMock, off: appOffMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const { installWindowAttention } = await import("./window-attention");

const CHANNEL = "vellum:window:attention";

const ATTENDED = { visible: true, focused: true, minimized: false };
const UNATTENDED = { visible: false, focused: false, minimized: false };

const makeRenderer = (destroyed = false): StubRenderer => {
  const contents: StubWebContents = {
    ...makeEmitter(),
    destroyed,
    isDestroyed: () => contents.destroyed,
    send: mock(() => undefined),
  };
  const renderer: StubRenderer = {
    destroyed,
    isDestroyed: () => renderer.destroyed,
    webContents: contents,
  };
  return renderer;
};

interface StubMainWindow extends StubEmitter {
  destroyed: boolean;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
}

const makeMainWindow = (): StubMainWindow => {
  const win: StubMainWindow = {
    ...makeEmitter(),
    destroyed: false,
    visible: true,
    focused: true,
    minimized: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isMinimized: () => win.minimized,
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
    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, ATTENDED);
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
      ATTENDED,
      { visible: true, focused: false, minimized: false },
      ATTENDED,
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
      ATTENDED,
      { visible: true, focused: false, minimized: true },
      ATTENDED,
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

    expect(payloads(renderer)).toEqual([ATTENDED, UNATTENDED, ATTENDED]);
    teardown();
  });

  test("publishes an unattended payload when the main window closes", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    let current: StubMainWindow | null = main;
    const teardown = installWindowAttention({
      currentMainWindow: () => current as unknown as BrowserWindow | null,
    });

    // A blur leaves the renderer holding a visible-but-unfocused window; the
    // destruction that follows is the only edge that can correct `visible`.
    main.focused = false;
    appListeners.get("browser-window-blur")?.();

    main.destroyed = true;
    current = null;
    main.emit("closed");

    expect(payloads(renderer)).toEqual([
      ATTENDED,
      { visible: true, focused: false, minimized: false },
      UNATTENDED,
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

  test("delivers to a renderer created after the last attention change", () => {
    const first = makeRenderer();
    windows = [first];
    const teardown = install(makeMainWindow());

    // No attention transition happens between the install and the new window,
    // so only the per-recipient record can tell that it has heard nothing.
    const late = makeRenderer();
    windows = [first, late];
    appListeners.get("browser-window-created")?.({}, late);
    late.webContents.emit("did-finish-load");

    expect(payloads(late)).toEqual([ATTENDED]);
    expect(first.webContents.send).toHaveBeenCalledTimes(1);
    teardown();
  });

  test("re-delivers to a renderer that reloads", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const teardown = install(makeMainWindow());

    renderer.webContents.emit("did-finish-load");

    expect(payloads(renderer)).toEqual([ATTENDED, ATTENDED]);
    teardown();
  });

  test("drops the subscriptions for a destroyed webContents", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const teardown = install(makeMainWindow());

    expect(renderer.webContents.listenerCount("did-finish-load")).toBe(1);
    renderer.webContents.destroyed = true;
    renderer.webContents.emit("destroyed");

    expect(renderer.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(renderer.webContents.listenerCount("destroyed")).toBe(0);
    teardown();
  });

  test("reports all false when the accessor returns null", () => {
    const renderer = makeRenderer();
    windows = [renderer];

    const teardown = install(null);

    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, UNATTENDED);
    teardown();
  });

  test("reports all false when the window is destroyed", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    main.destroyed = true;

    const teardown = install(main);

    expect(renderer.webContents.send).toHaveBeenCalledWith(CHANNEL, UNATTENDED);
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
      UNATTENDED,
      ATTENDED,
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

  test("teardown removes the app, window, and renderer listeners", () => {
    const renderer = makeRenderer();
    windows = [renderer];
    const main = makeMainWindow();
    const teardown = install(main);

    teardown();

    expect(appOffMock).toHaveBeenCalledTimes(3);
    expect(appListeners.size).toBe(0);
    for (const listeners of main.listeners.values()) {
      expect(listeners.size).toBe(0);
    }
    expect(renderer.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(renderer.webContents.listenerCount("destroyed")).toBe(0);

    main.minimized = true;
    main.emit("minimize");
    expect(renderer.webContents.send).toHaveBeenCalledTimes(1);
  });
});
