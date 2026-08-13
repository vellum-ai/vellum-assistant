import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
} from "@vellumai/ipc-contract";

interface WindowState {
  destroyed: boolean;
  focused: boolean;
  minimized: boolean;
  visible: boolean;
}

interface CloseEvent {
  preventDefault: () => void;
}

type WindowListener = (event?: CloseEvent) => void;

interface WindowStub {
  state: WindowState;
  options: Record<string, unknown>;
  emit: (event: string, payload?: CloseEvent) => void;
  webContents: {
    emit: (event: string) => void;
    isDestroyed: () => boolean;
    on: ReturnType<typeof mock>;
    once: (event: string, handler: () => void) => void;
    send: ReturnType<typeof mock>;
  };
  focus: ReturnType<typeof mock>;
  hide: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
  maximize: ReturnType<typeof mock>;
  restore: ReturnType<typeof mock>;
  setTitle: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  on: (event: string, handler: WindowListener) => WindowStub;
  once: (event: string, handler: WindowListener) => WindowStub;
}

const appListeners = new Map<string, () => void>();
const constructed: WindowStub[] = [];

const createWindowMock = mock(
  (options: {
    browserWindow: Record<string, unknown>;
    backgroundThrottling?: boolean;
  }) => {
    const state = {
      destroyed: false,
      focused: false,
      minimized: false,
      visible: false,
    };
    const listeners = new Map<string, WindowListener[]>();
    const webListeners = new Map<string, Array<() => void>>();
    const stub: WindowStub = {
      state,
      options: {
        ...options.browserWindow,
        backgroundThrottling: options.backgroundThrottling,
      },
      emit(event, payload) {
        if (event === "closed") {
          state.destroyed = true;
        }
        for (const handler of listeners.get(event) ?? []) {
          handler(payload);
        }
      },
      webContents: {
        emit(event) {
          for (const handler of webListeners.get(event) ?? []) {
            handler();
          }
        },
        isDestroyed: () => state.destroyed,
        on: mock(() => undefined),
        once(event, handler) {
          const handlers = webListeners.get(event) ?? [];
          handlers.push(handler);
          webListeners.set(event, handlers);
        },
        send: mock(() => undefined),
      },
      focus: mock(() => {
        state.focused = true;
      }),
      hide: mock(() => {
        state.visible = false;
      }),
      loadURL: mock(() => Promise.resolve()),
      maximize: mock(() => undefined),
      restore: mock(() => {
        state.minimized = false;
      }),
      setTitle: mock(() => undefined),
      show: mock(() => {
        state.visible = true;
      }),
      isDestroyed: () => state.destroyed,
      isFocused: () => state.focused,
      isMinimized: () => state.minimized,
      isVisible: () => state.visible,
      on(event, handler) {
        const handlers = listeners.get(event) ?? [];
        handlers.push(handler);
        listeners.set(event, handlers);
        return stub;
      },
      once(event, handler) {
        const handlers = listeners.get(event) ?? [];
        handlers.push(handler);
        listeners.set(event, handlers);
        return stub;
      },
    };
    constructed.push(stub);
    return stub;
  },
);

mock.module("./windows.client", () => ({ createWindow: createWindowMock }));
mock.module("./logger", () => ({
  default: { error: () => undefined },
}));
mock.module("electron", () => ({
  app: {
    isPackaged: false,
    once: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  BrowserWindow: class {},
  shell: { openExternal: () => Promise.resolve() },
}));

let restoredBounds: {
  x?: number;
  y?: number;
  width: number;
  height: number;
  fullscreen?: boolean;
  maximized?: boolean;
} = { width: 1280, height: 800 };
const trackMock = mock(() => undefined);
const writeOnboardingActiveMock = mock((_active: boolean) => undefined);

mock.module("@vellumai/electron-desktop/window-state", () => ({
  restoreBounds: () => restoredBounds,
  track: trackMock,
  writeOnboardingActive: writeOnboardingActiveMock,
}));

const invokeHandlers = new Map<string, (args: unknown[]) => unknown>();
const eventHandlers = new Map<string, (args: unknown[]) => void>();

mock.module("./ipc.client", () => ({
  handle: (
    channel: string,
    _schema: unknown,
    handler: (args: unknown[]) => unknown,
  ) => {
    invokeHandlers.set(channel, handler);
  },
  on: (
    channel: string,
    _schema: unknown,
    handler: (args: unknown[]) => void,
  ) => {
    eventHandlers.set(channel, handler);
  },
}));

const {
  __resetForTesting,
  dispatchToMain,
  ensureVisible,
  installMainWindow,
} = await import("./main-window");

const destroyWindows = (): void => {
  for (const win of constructed) {
    if (!win.state.destroyed) {
      win.emit("closed");
    }
  }
  constructed.length = 0;
};

beforeEach(() => {
  destroyWindows();
  __resetForTesting();
  appListeners.clear();
  invokeHandlers.clear();
  eventHandlers.clear();
  restoredBounds = { width: 1280, height: 800 };
  trackMock.mockClear();
  writeOnboardingActiveMock.mockClear();
});

afterEach(destroyWindows);

describe("Windows main window", () => {
  test("restores bounds with title-bar controls and live-voice timers enabled", () => {
    restoredBounds = { x: 40, y: 60, width: 1000, height: 700 };
    void ensureVisible();

    expect(constructed[0]?.options).toMatchObject({
      x: 40,
      y: 60,
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 44 },
      backgroundThrottling: false,
    });
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  test("restores a saved maximized session", () => {
    restoredBounds = { width: 1000, height: 700, maximized: true };
    void ensureVisible();
    const win = constructed[0];
    expect(win?.maximize).not.toHaveBeenCalled();
    win?.emit("ready-to-show");
    expect(win?.maximize).toHaveBeenCalledTimes(1);
  });

  test("restores a minimized window and recreates a destroyed window", () => {
    void ensureVisible();
    const first = constructed[0];
    if (!first) {
      throw new Error("expected a window");
    }
    first.state.minimized = true;
    void ensureVisible();
    expect(first.restore).toHaveBeenCalledTimes(1);

    first.emit("closed");
    void ensureVisible();
    expect(constructed).toHaveLength(2);
  });

  test("readiness waits for load and show", async () => {
    let resolved = false;
    const ready = ensureVisible().then(() => {
      resolved = true;
    });
    const win = constructed[0];
    if (!win) {
      throw new Error("expected a window");
    }

    win.webContents.emit("did-finish-load");
    await Promise.resolve();
    expect(resolved).toBe(false);

    win.emit("ready-to-show");
    await ready;
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  test("registers controls, onboarding, and live assistant title IPC", () => {
    installMainWindow();
    expect(invokeHandlers.has(MAIN_WINDOW_ENSURE_VISIBLE)).toBe(true);
    expect(invokeHandlers.has(MAIN_WINDOW_SET_ONBOARDING)).toBe(true);
    expect(eventHandlers.has(IDENTITY_NAME)).toBe(true);

    invokeHandlers.get(MAIN_WINDOW_SET_ONBOARDING)?.([true]);
    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(true);

    eventHandlers.get(IDENTITY_NAME)?.(["  Alice  "]);
    expect(constructed[0]?.setTitle).toHaveBeenLastCalledWith("Alice");
  });

  test("recreated windows keep the latest assistant title", () => {
    installMainWindow();
    eventHandlers.get(IDENTITY_NAME)?.(["Alice"]);
    constructed[0]?.emit("closed");
    void ensureVisible();
    expect(constructed[1]?.setTitle).toHaveBeenCalledWith("Alice");
  });

  test("dispatches commands to the current renderer", () => {
    void ensureVisible();
    dispatchToMain({ kind: "openSettings" });
    expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
      "vellum:command",
      { kind: "openSettings" },
    );
  });

  test("hides on close and allows close while quitting", () => {
    installMainWindow();
    const win = constructed[0];
    if (!win) {
      throw new Error("expected a window");
    }
    const hideClose = mock(() => undefined);

    win.emit("close", { preventDefault: hideClose });

    expect(hideClose).toHaveBeenCalledTimes(1);
    expect(win.hide).toHaveBeenCalledTimes(1);

    const quitClose = mock(() => undefined);
    appListeners.get("before-quit")?.();
    win.emit("close", { preventDefault: quitClose });

    expect(quitClose).not.toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(1);
  });
});
