import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
  MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
  type TitleBarOverlayTheme,
} from "@vellumai/ipc-contract";

type Listener = (event?: { preventDefault: () => void }) => void;

const appListeners = new Map<string, () => void>();
const constructed: StubWindow[] = [];

const makeWindow = (options: {
  browserWindow: Record<string, unknown>;
  backgroundThrottling?: boolean;
}) => {
  const state = {
    destroyed: false,
    focused: false,
    minimized: false,
    visible: false,
  };
  const listeners = new Map<string, Listener[]>();
  const webListeners = new Map<string, Array<() => void>>();
  const addListener = (event: string, handler: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return stub;
  };
  const stub = {
    state,
    options: {
      ...options.browserWindow,
      backgroundThrottling: options.backgroundThrottling,
    },
    emit(event: string, payload?: { preventDefault: () => void }) {
      state.destroyed ||= event === "closed";
      for (const handler of listeners.get(event) ?? []) {
        handler(payload);
      }
    },
    webContents: {
      emit: (event: string) => {
        for (const handler of webListeners.get(event) ?? []) {
          handler();
        }
      },
      isDestroyed: () => state.destroyed,
      on: mock(() => undefined),
      once: (event: string, handler: () => void) => {
        webListeners.set(event, [...(webListeners.get(event) ?? []), handler]);
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
    on: addListener,
    once: addListener,
  };
  return stub;
};

type StubWindow = ReturnType<typeof makeWindow>;

const createWindow = mock((options: Parameters<typeof makeWindow>[0]) => {
  const stub = makeWindow(options);
  constructed.push(stub);
  return stub;
});

mock.module("./windows.client", () => ({ createWindow }));
mock.module("./logger", () => ({ default: { error: () => undefined } }));
mock.module("electron", () => ({
  app: {
    isPackaged: false,
    once: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  BrowserWindow: class {},
  nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
  shell: { openExternal: () => Promise.resolve() },
}));

let restoredBounds: Record<string, unknown> = { width: 1280, height: 800 };
const track = mock(() => undefined);
const writeOnboardingActive = mock((_active: boolean) => undefined);
const writeTitleBarOverlayTheme = mock(
  (_theme: TitleBarOverlayTheme) => undefined,
);

mock.module("@vellumai/electron-desktop/window-state", () => ({
  restoreBounds: () => restoredBounds,
  track,
  readOnboardingActive: () => false,
  writeOnboardingActive,
  readTitleBarOverlayTheme: () => null,
  writeTitleBarOverlayTheme,
}));

const invokeHandlers = new Map<
  string,
  (args: unknown[], event: { sender: unknown }) => unknown
>();
const eventHandlers = new Map<string, (args: unknown[]) => void>();

mock.module("./ipc.client", () => ({
  handle: (channel: string, _schema: unknown, handler: unknown) => {
    invokeHandlers.set(channel, handler as never);
  },
  on: (channel: string, _schema: unknown, handler: unknown) => {
    eventHandlers.set(channel, handler as never);
  },
}));

const {
  __resetForTesting,
  dispatchToMain,
  ensureVisible,
  installMainWindow,
  toggleVisibility,
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
  track.mockClear();
  writeOnboardingActive.mockClear();
  writeTitleBarOverlayTheme.mockClear();
});

afterEach(destroyWindows);

describe("Linux main window", () => {
  test("restores bounds and a maximized session with live-voice timers on", () => {
    restoredBounds = {
      x: 40,
      y: 60,
      width: 1000,
      height: 700,
      maximized: true,
    };
    void ensureVisible();

    const win = constructed[0]!;
    expect(win.options).toMatchObject({
      x: 40,
      y: 60,
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      backgroundThrottling: false,
    });
    // Linux keeps the desktop's own frame: no native caption overlay.
    expect(win.options).not.toHaveProperty("titleBarOverlay");
    expect(track).toHaveBeenCalledTimes(1);
    expect(win.maximize).not.toHaveBeenCalled();
    win.emit("ready-to-show");
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  test("restores a minimized window and recreates a destroyed one", () => {
    void ensureVisible();
    const first = constructed[0]!;
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
    const win = constructed[0]!;

    win.webContents.emit("did-finish-load");
    await Promise.resolve();
    expect(resolved).toBe(false);

    win.emit("ready-to-show");
    await ready;
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  test("registers controls, onboarding, and the live assistant title", () => {
    installMainWindow();
    expect(invokeHandlers.has(MAIN_WINDOW_ENSURE_VISIBLE)).toBe(true);

    invokeHandlers.get(MAIN_WINDOW_SET_ONBOARDING)?.([true], {
      sender: constructed[0]?.webContents,
    });
    expect(writeOnboardingActive).toHaveBeenCalledWith(true);

    eventHandlers.get(IDENTITY_NAME)?.(["  Alice  "]);
    expect(constructed[0]?.setTitle).toHaveBeenLastCalledWith("Alice");

    // A recreated window keeps the latest title.
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

  test("persists the main window's theme and ignores every other sender", () => {
    // Auxiliary windows run the same renderer bundle: the offscreen
    // theme-stage window applies arbitrary workspace tokens for screenshots,
    // and persisting those would leak a staged palette into the next launch.
    installMainWindow();
    const theme = {
      color: "#17191C",
      symbolColor: "#F6F5F4",
      colorScheme: "dark",
    };

    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.([theme], {
      sender: { staged: true },
    });
    expect(writeTitleBarOverlayTheme).not.toHaveBeenCalled();

    invokeHandlers.get(MAIN_WINDOW_SET_TITLE_BAR_OVERLAY)?.([theme], {
      sender: constructed[0]?.webContents,
    });
    expect(writeTitleBarOverlayTheme).toHaveBeenCalledWith(theme);
  });

  test("toggling only hides a live window that is visible and focused", () => {
    // GIVEN no window yet, a toggle creates one rather than hiding
    toggleVisibility();
    const win = constructed[0]!;
    expect(win.hide).not.toHaveBeenCalled();
    win.emit("ready-to-show");

    // WHEN it is on screen but unfocused, it is brought forward
    win.state.focused = false;
    toggleVisibility();
    expect(win.hide).not.toHaveBeenCalled();

    // WHEN it has the user's attention, it hides
    win.state.focused = true;
    win.state.visible = true;
    toggleVisibility();
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.state.visible).toBe(false);

    // WHEN it is off screen, it comes back rather than hiding again
    toggleVisibility();
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.state.visible).toBe(true);
  });

  test("hides on close and allows close while quitting", () => {
    installMainWindow();
    const win = constructed[0]!;
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
