import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CreateWindowOptions } from "@vellumai/electron-desktop/windows";

type Listener = (...args: unknown[]) => void;

const created: Array<{
  options: CreateWindowOptions;
  window: StubWindow;
}> = [];
const handleListeners = new Map<string, Listener>();
const onListeners = new Map<string, Listener>();
const screenListeners = new Map<string, Listener>();
let workArea: Electron.Rectangle = { x: 0, y: 0, width: 1600, height: 900 };

const makeWindow = () => {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  const emit = (event: string, ...args: unknown[]): void => {
    if (event === "closed") {
      destroyed = true;
    }
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const addListener = (event: string, listener: Listener): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const window = {
    webContents: {
      isDestroyed: () => destroyed,
      on: () => undefined,
      send: mock(() => undefined),
    },
    close: mock(() => emit("closed")),
    emit,
    focus: mock(() => undefined),
    getBounds: () => workArea,
    hide: mock(() => undefined),
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    loadURL: mock(() => Promise.resolve()),
    on: addListener,
    once: addListener,
    restore: mock(() => undefined),
    setAlwaysOnTop: mock(() => undefined),
    setIgnoreMouseEvents: mock(() => undefined),
    setPosition: mock(() => undefined),
    setVisibleOnAllWorkspaces: mock(() => undefined),
    show: mock(() => undefined),
    showInactive: mock(() => undefined),
  };
  return window;
};

type StubWindow = ReturnType<typeof makeWindow>;

const createWindow = mock((options: CreateWindowOptions) => {
  const window = makeWindow();
  created.push({ options, window });
  return window;
});
const ensureVisible = mock(() => undefined);
const dispatchToMain = mock(() => undefined);

mock.module("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {
    static getAllWindows() {
      return created.map(({ window }) => window).filter((win) => !win.isDestroyed());
    }

    static getFocusedWindow() {
      return null;
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: workArea.x, y: workArea.y }),
    getDisplayMatching: () => ({ workArea }),
    getDisplayNearestPoint: () => ({ workArea }),
    on: (event: string, listener: Listener) => {
      screenListeners.set(event, listener);
    },
  },
}));
mock.module("./windows.client", () => ({ createWindow }));
mock.module("./ipc.client", () => ({
  handle: (channel: string, _schema: unknown, listener: Listener) => {
    handleListeners.set(channel, listener);
  },
  on: (channel: string, _schema: unknown, listener: Listener) => {
    onListeners.set(channel, listener);
  },
}));
mock.module("./main-window", () => ({
  current: () => null,
  dispatchToMain,
  ensureVisible,
}));

const { default: auxiliaryWindowsModule } = await import("./features/auxiliary-windows");
const { toggleQuickInput } = await import("@vellumai/electron-desktop/quick-input-window");

beforeAll(() => {
  auxiliaryWindowsModule.install({} as never);
});
beforeEach(() => {
  created.length = 0;
  workArea = { x: 0, y: 0, width: 1600, height: 900 };
});

afterEach(() => {
  for (const { window } of created) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
});
describe("Windows auxiliary windows", () => {
  test("reuses a focused command palette with Windows frame policy", () => {
    handleListeners.get("vellum:commandPalette:open")?.([]);
    handleListeners.get("vellum:commandPalette:open")?.([]);
    expect(created).toHaveLength(1);
    const { options, window } = created[0]!;
    expect(options.browserWindow).toMatchObject({
      frame: false,
      focusable: true,
      skipTaskbar: true,
    });
    expect(options.browserWindow).not.toHaveProperty("type");
    expect(window.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/floating/command-palette",
    );
    expect(window.focus).toHaveBeenCalledTimes(2);
  });

  test("toggles Quick Input on the active display and closes on blur", () => {
    workArea = { x: 1600, y: 40, width: 1200, height: 800 };
    toggleQuickInput();
    const { options, window } = created[0]!;
    window.emit("ready-to-show");
    expect(options.browserWindow).toMatchObject({
      x: 1840,
      y: 324,
      alwaysOnTop: true,
    });
    expect(window.loadURL).toHaveBeenCalledWith("http://localhost:5173/assistant/quick-input");
    window.emit("blur");
    expect(window.isDestroyed()).toBe(true);
  });

  test("keeps the dictation overlay passive and topmost", () => {
    onListeners.get("vellum:dictationOverlay:setState")?.([
      { kind: "recording", transcription: "hello" },
    ]);
    const { options, window } = created[0]!;
    expect(options.navigation).toBe("deny-all");
    expect(options.browserWindow).toMatchObject({
      focusable: false,
      skipTaskbar: true,
    });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
    expect(window.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/floating/dictation-overlay",
    );
  });

  test("repositions transient windows after a display change", () => {
    handleListeners.get("vellum:commandPalette:open")?.([]);
    toggleQuickInput();
    onListeners.get("vellum:dictationOverlay:setState")?.([
      { kind: "recording", transcription: "" },
    ]);
    workArea = { x: 1920, y: 20, width: 1000, height: 700 };
    screenListeners.get("display-metrics-changed")?.();
    expect(created[0]!.window.setPosition).toHaveBeenLastCalledWith(2128, 148);
    expect(created[1]!.window.setPosition).toHaveBeenLastCalledWith(2060, 264);
    expect(created[2]!.window.setPosition).toHaveBeenLastCalledWith(2180, 20);
  });

  test("keeps popouts independent from the main window", () => {
    handleListeners.get("vellum:popout:open")?.(["conv-123"]);
    const { options, window: popout } = created[0]!;
    makeWindow().close();
    popout.emit("ready-to-show");
    handleListeners.get("vellum:popout:open")?.(["conv-123"]);
    expect(popout.isDestroyed()).toBe(false);
    expect(options.browserWindow).not.toHaveProperty("parent");
    expect(options.browserWindow.show).toBe(false);
    expect(options.backgroundThrottling).toBe(false);
    expect(popout.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/conversations/conv-123?popout=1",
    );
    expect(popout.focus).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(1);
  });
});
