import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { CreateWindowOptions } from "@vellumai/electron-desktop/windows";

type Listener = (...args: unknown[]) => void;

const created: Array<{ options: CreateWindowOptions; window: StubWindow }> = [];
const handleListeners = new Map<string, Listener>();
const onListeners = new Map<string, Listener>();
const shortcutListeners = new Map<string, Listener>();
const appListeners = new Map<string, Listener>();
let focusedWindow: object | null = null;
let workArea: Electron.Rectangle = { x: 0, y: 0, width: 1600, height: 900 };

const makeWindow = () => {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  const emit = (event: string, ...args: unknown[]): void => {
    destroyed ||= event === "closed";
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const addListener = (event: string, listener: Listener): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  return {
    webContents: {
      isDestroyed: () => destroyed,
      on: () => undefined,
      send: mock(() => undefined),
      getZoomFactor: () => 1,
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
};

type StubWindow = ReturnType<typeof makeWindow>;

const createWindow = mock((options: CreateWindowOptions) => {
  const window = makeWindow();
  created.push({ options, window });
  return window;
});
const dispatchToMain = mock(() => undefined);

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    on: (event: string, listener: Listener) =>
      appListeners.set(event, listener),
    off: (event: string) => appListeners.delete(event),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return created
        .map(({ window }) => window)
        .filter((w) => !w.isDestroyed());
    }
    static getFocusedWindow() {
      return focusedWindow;
    }
  },
  globalShortcut: {
    register: (accelerator: string, listener: Listener) => {
      shortcutListeners.set(accelerator, listener);
      return true;
    },
    unregister: (accelerator: string) => shortcutListeners.delete(accelerator),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: workArea.x, y: workArea.y }),
    getDisplayMatching: () => ({ workArea }),
    getDisplayNearestPoint: () => ({ workArea }),
    on: () => undefined,
  },
}));
const restoreBounds = mock(
  (_key: string, defaults: { width: number; height: number }) => defaults,
);
const trackWindowState = mock((_key: string, _win: unknown) => undefined);
mock.module("@vellumai/electron-desktop/window-state", () => ({
  restoreBounds,
  track: trackWindowState,
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
  ensureVisible: mock(() => undefined),
}));
mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

const { default: auxiliaryWindows } =
  await import("./features/auxiliary-windows");
const { toggleQuickInput } =
  await import("@vellumai/electron-desktop/quick-input-window");

const setOverlayState = (state: Record<string, unknown>): void => {
  onListeners.get("vellum:dictationOverlay:setState")?.([state]);
};

beforeAll(() => {
  auxiliaryWindows.install({} as never);
});
beforeEach(() => {
  created.length = 0;
  focusedWindow = null;
  dispatchToMain.mockClear();
  workArea = { x: 0, y: 0, width: 1600, height: 900 };
});
afterEach(() => {
  for (const { window } of created) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
});

describe("Linux auxiliary windows", () => {
  test("reuses a focused command palette with the non-panel frame policy", () => {
    handleListeners.get("vellum:commandPalette:open")?.([]);
    handleListeners.get("vellum:commandPalette:open")?.([]);
    expect(created).toHaveLength(1);
    const { options, window } = created[0]!;
    expect(options.browserWindow).toMatchObject({
      frame: false,
      focusable: true,
      skipTaskbar: true,
    });
    // `type: "panel"` is a macOS-only window level.
    expect(options.browserWindow).not.toHaveProperty("type");
    expect(window.focus).toHaveBeenCalledTimes(2);
  });

  test("opens Quick Input on the cursor's display and closes on blur", () => {
    workArea = { x: 1600, y: 40, width: 1200, height: 800 };
    toggleQuickInput();
    const { options, window } = created[0]!;
    window.emit("ready-to-show");
    expect(options.browserWindow).toMatchObject({
      x: 1840,
      y: 324,
      alwaysOnTop: true,
    });
    expect(window.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/quick-input",
    );
    window.emit("blur");
    expect(window.isDestroyed()).toBe(true);
  });

  test("keeps the dictation overlay passive, topmost, and click-testable", async () => {
    setOverlayState({ kind: "recording", transcription: "hello" });
    const { options, window } = created[0]!;
    expect(options.browserWindow).toMatchObject({
      focusable: false,
      skipTaskbar: true,
    });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/floating/dictation-overlay",
    );

    // Main hit-tests the cursor against the Stop region the overlay page
    // reports; the mocked cursor sits at the window's origin.
    onListeners.get("vellum:dictationOverlay:setHitRegion")?.([
      { x: 0, y: 0, width: 24, height: 24 },
    ]);
    await Bun.sleep(120);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false);

    setOverlayState({ kind: "dismiss" });
    expect(window.isDestroyed()).toBe(true);
  });

  test("Escape cancels dictation only while Vellum is unfocused", () => {
    setOverlayState({ kind: "recording", transcription: "" });
    shortcutListeners.get("Escape")?.();
    expect(dispatchToMain).toHaveBeenCalledWith({ kind: "cancelDictation" });

    dispatchToMain.mockClear();
    focusedWindow = created[0]!.window;
    appListeners.get("browser-window-focus")?.();
    expect(shortcutListeners.has("Escape")).toBe(false);

    focusedWindow = null;
    appListeners.get("browser-window-blur")?.();
    setOverlayState({ kind: "dismiss" });
    expect(shortcutListeners.has("Escape")).toBe(false);
    expect(dispatchToMain).not.toHaveBeenCalled();
  });

  test("keeps popouts independent from the main window", () => {
    handleListeners.get("vellum:popout:open")?.(["conv-123"]);
    const { options, window: popout } = created[0]!;
    popout.emit("ready-to-show");
    handleListeners.get("vellum:popout:open")?.(["conv-123"]);
    expect(popout.isDestroyed()).toBe(false);
    expect(restoreBounds).toHaveBeenCalledWith("thread.conv-123", {
      width: 720,
      height: 800,
    });
    expect(trackWindowState).toHaveBeenCalledWith("thread.conv-123", popout);
    expect(options.browserWindow).not.toHaveProperty("parent");
    expect(options.backgroundThrottling).toBe(false);
    expect(popout.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/assistant/conversations/conv-123?popout=1",
    );
    expect(popout.focus).toHaveBeenCalledTimes(2);
  });
});
