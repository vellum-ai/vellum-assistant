import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WINDOW_ATTENTION } from "@vellumai/ipc-contract";

// `app.on` subscriptions are captured by event name so the test can fire
// them at will, and `BrowserWindow.getAllWindows` returns a controllable
// stub list standing in for the live windows, each of which owns both the
// visibility state main reads and the renderer that receives the payload.
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

interface WindowState {
  destroyed: boolean;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

interface StubWindow extends StubEmitter, WindowState {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
  webContents: StubWebContents;
}

let windows: StubWindow[] = [];

mock.module("electron", () => ({
  app: { on: appOnMock, off: appOffMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const { installWindowAttention } = await import("./window-attention");

const CHANNEL = WINDOW_ATTENTION;

const ATTENDED = { visible: true, focused: true, minimized: false };
const UNFOCUSED = { visible: true, focused: false, minimized: false };
const MINIMIZED = { visible: true, focused: false, minimized: true };
const HIDDEN = { visible: false, focused: false, minimized: false };

const makeWindow = (initial: Partial<WindowState> = {}): StubWindow => {
  const contents: StubWebContents = {
    ...makeEmitter(),
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    send: mock(() => undefined),
  };
  const win: StubWindow = {
    ...makeEmitter(),
    destroyed: false,
    visible: true,
    focused: true,
    minimized: false,
    ...initial,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isMinimized: () => win.minimized,
    webContents: contents,
  };
  return win;
};

const payloads = (win: StubWindow): unknown[] => {
  return win.webContents.send.mock.calls.map((call) => call[1]);
};

/** Destroy a window the way Electron does before it emits `closed`. */
const close = (win: StubWindow): void => {
  windows = windows.filter((candidate) => candidate !== win);
  win.destroyed = true;
  win.webContents.destroyed = true;
  win.emit("closed");
};

beforeEach(() => {
  appListeners.clear();
  appOnMock.mockClear();
  appOffMock.mockClear();
  windows = [];
});

describe("installWindowAttention", () => {
  test("sends each window its own state on install", () => {
    const main = makeWindow();
    const popout = makeWindow({ focused: false });
    windows = [main, popout];

    const teardown = installWindowAttention();

    expect(main.webContents.send).toHaveBeenCalledWith(CHANNEL, ATTENDED);
    expect(popout.webContents.send).toHaveBeenCalledWith(CHANNEL, UNFOCUSED);
    teardown();
  });

  test("emits on browser-window-blur and browser-window-focus", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    main.focused = false;
    appListeners.get("browser-window-blur")?.();
    main.focused = true;
    appListeners.get("browser-window-focus")?.();

    expect(payloads(main)).toEqual([ATTENDED, UNFOCUSED, ATTENDED]);
    teardown();
  });

  test("emits on the window's own minimize and restore", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    main.minimized = true;
    main.focused = false;
    main.emit("minimize");
    main.minimized = false;
    main.focused = true;
    main.emit("restore");

    expect(payloads(main)).toEqual([ATTENDED, MINIMIZED, ATTENDED]);
    teardown();
  });

  test("emits on the window's own hide and show", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    main.visible = false;
    main.focused = false;
    main.emit("hide");
    main.visible = true;
    main.focused = true;
    main.emit("show");

    expect(payloads(main)).toEqual([ATTENDED, HIDDEN, ATTENDED]);
    teardown();
  });

  test("leaves a pop-out on screen when the main window minimizes", () => {
    const main = makeWindow();
    const popout = makeWindow({ focused: false });
    windows = [main, popout];
    const teardown = installWindowAttention();

    main.minimized = true;
    main.focused = false;
    main.emit("minimize");

    // The pop-out is still showing its conversation, so nothing about it
    // changed and its renderer hears no off-screen payload it would tear the
    // SSE stream down on.
    expect(payloads(main)).toEqual([ATTENDED, MINIMIZED]);
    expect(payloads(popout)).toEqual([UNFOCUSED]);
    teardown();
  });

  test("emits a pop-out's own minimize without touching the main window", () => {
    const main = makeWindow();
    const popout = makeWindow({ focused: false });
    windows = [main, popout];
    const teardown = installWindowAttention();

    popout.minimized = true;
    popout.emit("minimize");

    expect(payloads(popout)).toEqual([UNFOCUSED, MINIMIZED]);
    expect(payloads(main)).toEqual([ATTENDED]);
    teardown();
  });

  test("corrects the surviving windows when one closes", () => {
    const main = makeWindow();
    const popout = makeWindow({ focused: false });
    windows = [main, popout];
    const teardown = installWindowAttention();

    // Closing the focused window hands focus to whatever is left, and the
    // window that receives it is not guaranteed an app-level focus event.
    popout.focused = true;
    close(main);

    expect(payloads(popout)).toEqual([UNFOCUSED, ATTENDED]);
    teardown();
  });

  test("drops every subscription a closed pop-out held", () => {
    const main = makeWindow();
    const popout = makeWindow({ focused: false });
    windows = [main, popout];
    const teardown = installWindowAttention();

    close(popout);

    for (const listeners of popout.listeners.values()) {
      expect(listeners.size).toBe(0);
    }
    expect(popout.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(popout.webContents.listenerCount("destroyed")).toBe(0);
    teardown();
  });

  test("suppresses a duplicate consecutive payload", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    appListeners.get("browser-window-focus")?.();
    appListeners.get("browser-window-focus")?.();
    main.emit("restore");

    expect(main.webContents.send).toHaveBeenCalledTimes(1);
    teardown();
  });

  test("delivers to a window created after the last attention change", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    // No attention transition happens between the install and the new window,
    // so only the per-recipient record can tell that it has heard nothing.
    const popout = makeWindow({ focused: false });
    windows = [main, popout];
    appListeners.get("browser-window-created")?.({}, popout);
    popout.webContents.emit("did-finish-load");

    expect(payloads(popout)).toEqual([UNFOCUSED]);
    expect(main.webContents.send).toHaveBeenCalledTimes(1);
    teardown();
  });

  test("re-delivers to a window that reloads", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    main.webContents.emit("did-finish-load");

    expect(payloads(main)).toEqual([ATTENDED, ATTENDED]);
    teardown();
  });

  test("drops the subscriptions for a destroyed webContents", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    expect(main.webContents.listenerCount("did-finish-load")).toBe(1);
    main.webContents.destroyed = true;
    main.webContents.emit("destroyed");

    expect(main.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(main.webContents.listenerCount("destroyed")).toBe(0);
    for (const listeners of main.listeners.values()) {
      expect(listeners.size).toBe(0);
    }
    teardown();
  });

  test("skips destroyed windows", () => {
    const alive = makeWindow();
    const dead = makeWindow({ destroyed: true });
    windows = [alive, dead];

    const teardown = installWindowAttention();

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(dead.listeners.size).toBe(0);
    teardown();
  });

  test("teardown removes the app, window, and renderer listeners", () => {
    const main = makeWindow();
    windows = [main];
    const teardown = installWindowAttention();

    teardown();

    expect(appOffMock).toHaveBeenCalledTimes(3);
    expect(appListeners.size).toBe(0);
    for (const listeners of main.listeners.values()) {
      expect(listeners.size).toBe(0);
    }
    expect(main.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(main.webContents.listenerCount("destroyed")).toBe(0);

    main.minimized = true;
    main.emit("minimize");
    expect(main.webContents.send).toHaveBeenCalledTimes(1);
  });
});
