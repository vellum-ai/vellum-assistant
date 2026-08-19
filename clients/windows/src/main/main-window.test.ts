import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
  MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
  type TitleBarOverlayTheme,
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
  setTitleBarOverlay: ReturnType<typeof mock>;
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
      setTitleBarOverlay: mock(() => undefined),
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
/**
 * Windows' own light/dark setting and the app's override of it, which is what
 * Chromium washes the caption buttons from.
 */
const nativeThemeStub: {
  themeSource: "system" | "light" | "dark";
  shouldUseDarkColorsForSystemIntegratedUI: boolean;
  readonly shouldUseDarkColors: boolean;
} = {
  themeSource: "system",
  shouldUseDarkColorsForSystemIntegratedUI: false,
  get shouldUseDarkColors() {
    return nativeThemeStub.themeSource === "system"
      ? nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI
      : nativeThemeStub.themeSource === "dark";
  },
};

/** The override in force, read through a call so cases assert unnarrowed. */
const themeSource = (): string => nativeThemeStub.themeSource;

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    once: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  BrowserWindow: class {},
  nativeTheme: nativeThemeStub,
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
let persistedOverlayTheme: TitleBarOverlayTheme | null = null;
const writeTitleBarOverlayThemeMock = mock(
  (_theme: TitleBarOverlayTheme) => undefined,
);

mock.module("@vellumai/electron-desktop/window-state", () => ({
  restoreBounds: () => restoredBounds,
  track: trackMock,
  writeOnboardingActive: writeOnboardingActiveMock,
  readTitleBarOverlayTheme: () => persistedOverlayTheme,
  writeTitleBarOverlayTheme: writeTitleBarOverlayThemeMock,
}));

/** The sender identity `ipcMain.handle` hands a privileged handler. */
interface InvokeEventStub {
  sender: unknown;
}

const invokeHandlers = new Map<
  string,
  (args: unknown[], event: InvokeEventStub) => unknown
>();
const eventHandlers = new Map<string, (args: unknown[]) => void>();

mock.module("./ipc.client", () => ({
  handle: (
    channel: string,
    _schema: unknown,
    handler: (args: unknown[], event: InvokeEventStub) => unknown,
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
  persistedOverlayTheme = null;
  nativeThemeStub.themeSource = "system";
  nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI = false;
  trackMock.mockClear();
  writeOnboardingActiveMock.mockClear();
  writeTitleBarOverlayThemeMock.mockClear();
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

    expect(invokeHandlers.has(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)).toBe(true);

    invokeHandlers.get(MAIN_WINDOW_SET_ONBOARDING)?.([true], {
      sender: constructed[0]?.webContents,
    });
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

  test("opens on the persisted overlay colors so launch is themed", () => {
    /**
     * The overlay's colors are constructor options, so a launch that ignored
     * the persisted pair would draw the system caption colors until the
     * renderer reported its theme.
     */
    // GIVEN a renderer published the velvet theme on a past launch
    persistedOverlayTheme = {
      color: "#121214",
      symbolColor: "#F6F5F4",
      colorScheme: "dark",
    };

    // WHEN the window is created
    void ensureVisible();

    // THEN the caption buttons are built in those colors, at the title bar's
    // own height
    expect(constructed[0]?.options.titleBarOverlay).toEqual({
      color: "#121214",
      symbolColor: "#F6F5F4",
      height: 44,
    });
  });

  test("repaints the caption buttons when the renderer changes theme", () => {
    /**
     * Tests that a theme change reaches the native overlay, which no
     * stylesheet can.
     */
    // GIVEN a running window
    installMainWindow();

    // WHEN its renderer publishes the dark theme
    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.(
      [{ color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" }],
      { sender: constructed[0]?.webContents },
    );

    // THEN the live window is repainted, keeping the title bar's height
    expect(constructed[0]?.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#17191C",
      symbolColor: "#F6F5F4",
      height: 44,
    });
    // AND the theme is persisted for the next launch's constructor
    expect(writeTitleBarOverlayThemeMock).toHaveBeenCalledWith({
      color: "#17191C",
      symbolColor: "#F6F5F4",
      colorScheme: "dark",
    });
  });

  test("puts the native scheme on the app's so the buttons react to the pointer", () => {
    /**
     * Chromium draws a caption button's hover and press wash from the native
     * frame's scheme rather than from the overlay color, so a dark title bar
     * under a light system scheme is washed in black on black and the buttons
     * look inert.
     */
    // GIVEN a running window on a machine set to light mode
    nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI = false;
    installMainWindow();

    // WHEN its renderer publishes a dark theme
    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.(
      [{ color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" }],
      { sender: constructed[0]?.webContents },
    );

    // THEN the native scheme is overridden to dark, putting the wash on the
    // light side of the surface it lands on
    expect(themeSource()).toBe("dark");
  });

  test("leaves the native scheme following the OS when the two agree", () => {
    /**
     * Tests that a theme matching the machine's own setting keeps the renderer
     * on `prefers-color-scheme: system`, which the override would pin.
     */
    // GIVEN a running window on a machine set to dark mode
    nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI = true;
    installMainWindow();

    // WHEN its renderer publishes a dark theme
    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.(
      [{ color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" }],
      { sender: constructed[0]?.webContents },
    );

    // THEN no override is installed
    expect(themeSource()).toBe("system");
  });

  test("reads the machine's scheme through an override already in force", () => {
    /**
     * Tests that the override is lifted rather than latched: once one is in
     * force `shouldUseDarkColors` reports the override, so a light theme on a
     * light machine has to be recognized as needing none.
     */
    // GIVEN a light-mode machine an earlier dark theme overrode to dark
    nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI = false;
    nativeThemeStub.themeSource = "dark";
    installMainWindow();

    // WHEN its renderer publishes a light theme
    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.(
      [{ color: "#F6F5F4", symbolColor: "#24292E", colorScheme: "light" }],
      { sender: constructed[0]?.webContents },
    );

    // THEN the override is released back to the machine's own setting
    expect(themeSource()).toBe("system");
  });

  test("opens on the persisted scheme so the first hover reacts", () => {
    /**
     * The scheme is applied alongside the overlay's constructor colors so the
     * window is built with the wash already on the right side of its surface.
     */
    // GIVEN a light-mode machine and a persisted dark theme
    nativeThemeStub.shouldUseDarkColorsForSystemIntegratedUI = false;
    persistedOverlayTheme = {
      color: "#121214",
      symbolColor: "#F6F5F4",
      colorScheme: "dark",
    };

    // WHEN the window is created
    void ensureVisible();

    // THEN the native scheme is overridden before the renderer loads
    expect(themeSource()).toBe("dark");
  });

  test("ignores overlay colors from other windows", () => {
    /**
     * Tests that only the window wearing the overlay can color it. Auxiliary
     * windows run the same renderer bundle: the offscreen theme-stage window
     * applies arbitrary workspace tokens for screenshots, and painting or
     * persisting those would leak a staged palette onto the visible window.
     */
    // GIVEN a running window
    installMainWindow();

    // WHEN some other window's renderer publishes a theme
    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.(
      [{ color: "#e8a04c", symbolColor: "#17191C", colorScheme: "light" }],
      { sender: { staged: true } },
    );

    // THEN the overlay keeps its colors, and none are persisted
    expect(constructed[0]?.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(writeTitleBarOverlayThemeMock).not.toHaveBeenCalled();
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
