import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => void;

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string, ...args: unknown[]) => void;
  send: ReturnType<typeof mock>;
};

type StubWindow = {
  webContents: StubWebContents;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  getBounds: () => Electron.Rectangle;
  on: (event: string, listener: Listener) => StubWindow;
  emit: (event: string, ...args: unknown[]) => void;
  close: ReturnType<typeof mock>;
  setPosition: ReturnType<typeof mock>;
  setAlwaysOnTop: ReturnType<typeof mock>;
  setVisibleOnAllWorkspaces: ReturnType<typeof mock>;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  showInactive: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
};

type FocusedSource = {
  webContents: { send: ReturnType<typeof mock> };
  isDestroyed: () => boolean;
  getBounds: () => Electron.Rectangle;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

const appState = { isPackaged: false, name: "Vellum" };
const created: Array<{ opts: CreateWindowOptions; win: StubWindow }> = [];
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

let focusedWindow: StubWindow | FocusedSource | null = null;
let activeWorkArea: Electron.Rectangle = {
  x: 1440,
  y: 100,
  width: 1600,
  height: 900,
};
let currentMainWindow: {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
} | null = null;

const makeWindow = (): StubWindow => {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
  let webContentsDestroyed = false;
  let visible = false;
  let minimized = false;
  const bounds: Electron.Rectangle = {
    x: 0,
    y: 0,
    width: 584,
    height: 444,
  };

  const webContents: StubWebContents = {
    on: (event, listener) => {
      const listeners = webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      webContentsListeners.set(event, listeners);
      return webContents;
    },
    isDestroyed: () => webContentsDestroyed,
    emit: (event, ...args) => {
      if (event === "destroyed") webContentsDestroyed = true;
      for (const listener of webContentsListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    send: mock(() => undefined),
  };

  const win: StubWindow = {
    webContents,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    getBounds: () => ({ ...bounds }),
    on: (event, listener) => {
      const listeners = windowListeners.get(event) ?? [];
      listeners.push(listener);
      windowListeners.set(event, listeners);
      return win;
    },
    emit: (event, ...args) => {
      if (event === "closed") {
        destroyed = true;
        visible = false;
      }
      if (event === "hide") visible = false;
      if (event === "show") visible = true;
      for (const listener of windowListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    close: mock(() => {
      win.emit("closed");
    }),
    setPosition: mock((x: number, y: number) => {
      bounds.x = x;
      bounds.y = y;
    }),
    setAlwaysOnTop: mock((_flag: boolean, _level: string) => undefined),
    setIgnoreMouseEvents: mock((_ignore: boolean) => undefined),
    setVisibleOnAllWorkspaces: mock(
      (_visible: boolean, _opts: Record<string, boolean>) => undefined,
    ),
    show: mock(() => {
      visible = true;
    }),
    focus: mock(() => {
      focusedWindow = win;
    }),
    showInactive: mock(() => {
      visible = true;
    }),
    loadURL: mock((_url: string) => Promise.resolve()),
  };
  Object.defineProperty(win, "__setMinimized", {
    value: (value: boolean) => {
      minimized = value;
    },
  });
  return win;
};

const makeFocusedSource = (
  bounds: Electron.Rectangle = { x: 1500, y: 200, width: 900, height: 700 },
): FocusedSource => ({
  webContents: { send: mock(() => undefined) },
  isDestroyed: () => false,
  getBounds: () => bounds,
});

const makeMainWindow = ({
  visible = true,
  minimized = false,
  destroyed = false,
}: {
  visible?: boolean;
  minimized?: boolean;
  destroyed?: boolean;
}) => ({
  isDestroyed: () => destroyed,
  isVisible: () => visible,
  isMinimized: () => minimized,
});

const createWindowMock = mock((opts: CreateWindowOptions): StubWindow => {
  const win = makeWindow();
  created.push({ opts, win });
  return win;
});

const handleMock = mock(
  (
    channel: string,
    _schema: unknown,
    fn: (...args: unknown[]) => unknown,
  ) => {
    ipcHandlers.set(channel, fn);
  },
);

const ensureVisibleMock = mock(async () => undefined);
const dispatchToMainMock = mock((_command: unknown) => undefined);

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: class {
    static getFocusedWindow() {
      return focusedWindow;
    }

    static getAllWindows() {
      return focusedWindow ? [focusedWindow] : [];
    }
  },
  Menu: {
    buildFromTemplate: mock((template: unknown) => template),
    setApplicationMenu: mock((_menu: unknown) => undefined),
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: activeWorkArea }),
    getDisplayMatching: mock((_bounds: Electron.Rectangle) => ({
      workArea: activeWorkArea,
    })),
  },
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
}));

mock.module("./windows", () => ({
  createWindow: createWindowMock,
}));

mock.module("./ipc", () => ({
  handle: handleMock,
}));

mock.module("./main-window", () => ({
  current: () => currentMainWindow,
  ensureVisible: ensureVisibleMock,
  dispatchToMain: dispatchToMainMock,
}));

mock.module("./settings", () => ({
  readHotkeyOverride: () => null,
  readSetting: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

mock.module("./about", () => ({
  openAboutWindow: mock(() => undefined),
}));

mock.module("./auto-update", () => ({
  checkForUpdates: mock(() => undefined),
}));

mock.module("./devtools", () => ({
  areChromeDevToolsEnabled: () => false,
}));

mock.module("./window-state", () => ({
  readOnboardingActive: () => false,
}));

// Full `./cli-path-installer` surface so this mock — which leaks into co-run
// test files via the global module registry — doesn't break sibling modules.
mock.module("./cli-path-installer", () => ({
  WRAPPER_MARKER: "# vellum-cli-wrapper v1",
  getWrapperDir: () => "/tmp/.local/bin",
  getWrapperPath: () => "/tmp/.local/bin/vellum",
  buildWrapperScript: () => "",
  readWrapperOwnership: () => "absent",
  installWrapper: () => "installed",
  getCliPathInstallState: async () => ({ kind: "not-installed" }),
  uninstallWrapper: () => "absent",
}));

mock.module("./cli-path-flow", () => ({
  runInstallCliCommandFlow: async () => undefined,
  runUninstallCliCommandFlow: async () => undefined,
  isCliPathFlowInFlight: () => false,
}));

const {
  __resetForTesting,
  installCommandPaletteWindow,
  openCommandPaletteWindow,
  selectCommandPaletteCommand,
} = await import("./command-palette-window");
const { dispatchMenuCommand } = await import("./menu");

beforeEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
  created.length = 0;
  ipcHandlers.clear();
  createWindowMock.mockClear();
  handleMock.mockClear();
  ensureVisibleMock.mockClear();
  dispatchToMainMock.mockClear();
  appState.isPackaged = false;
  process.env.VELLUM_DEV_URL = "http://localhost:4242/assistant/";
  activeWorkArea = { x: 1440, y: 100, width: 1600, height: 900 };
  focusedWindow = makeFocusedSource();
  currentMainWindow = null;
  __resetForTesting();
});

afterEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
  delete process.env.VELLUM_DEV_URL;
});

describe("openCommandPaletteWindow", () => {
  test("opens a focused singleton floating window centered in the focused display work area", () => {
    const first = openCommandPaletteWindow();
    expect(first).toBeUndefined();

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    const { opts, win } = created[0]!;
    expect(opts.navigation).toBe("deny-all");
    expect(opts.browserWindow).toMatchObject({
      type: "panel",
      width: 584,
      height: 444,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      backgroundColor: "#00000000",
    });
    expect(win.setPosition.mock.calls).toEqual([[1948, 328]]);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "http://localhost:4242/assistant/floating/command-palette",
    );

    openCommandPaletteWindow();

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalledTimes(2);
    expect(win.loadURL).toHaveBeenCalledTimes(1);
  });

  test("closes when the floating window blurs", () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;

    win.emit("blur");

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.isDestroyed()).toBe(true);
  });

  test("closes on Escape before-input events", () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;
    const preventDefault = mock(() => undefined);

    win.webContents.emit(
      "before-input-event",
      { preventDefault },
      {
        type: "keyDown",
        key: "Escape",
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.isDestroyed()).toBe(true);
  });
});

describe("installCommandPaletteWindow", () => {
  test("registers open, dismiss, and select IPC handlers", async () => {
    installCommandPaletteWindow();

    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      "vellum:commandPalette:open",
      "vellum:commandPalette:dismiss",
      "vellum:commandPalette:select",
    ]);

    ipcHandlers.get("vellum:commandPalette:open")?.([]);
    expect(created).toHaveLength(1);

    ipcHandlers.get("vellum:commandPalette:dismiss")?.([]);
    expect(created[0]!.win.close).toHaveBeenCalledTimes(1);

    currentMainWindow = makeMainWindow({ visible: true });
    await ipcHandlers.get("vellum:commandPalette:select")?.([
      { kind: "home" },
    ]);
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "home" });

    await ipcHandlers.get("vellum:commandPalette:select")?.([
      { kind: "openConversation", conversationId: "conv-123" },
    ]);
    expect(dispatchToMainMock).toHaveBeenCalledWith({
      kind: "openConversation",
      conversationId: "conv-123",
    });
  });
});

describe("selectCommandPaletteCommand", () => {
  test("closes the palette and dispatches to a visible main window without refocusing it", async () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;
    currentMainWindow = makeMainWindow({ visible: true });

    await selectCommandPaletteCommand({ kind: "openSettings" });

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(ensureVisibleMock).not.toHaveBeenCalled();
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "openSettings" });
  });

  test("ensures the main window before dispatch when it is hidden", async () => {
    currentMainWindow = makeMainWindow({ visible: false });

    await selectCommandPaletteCommand({ kind: "shareFeedback" });

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "shareFeedback" });
  });
});

describe("dispatchMenuCommand", () => {
  test("routes the Command Palette menu command to the floating window", () => {
    const source = makeFocusedSource();
    focusedWindow = source;

    dispatchMenuCommand({ kind: "commandPalette" });

    expect(created).toHaveLength(1);
    expect(source.webContents.send).not.toHaveBeenCalled();
  });

  test("closes the focused palette when the Command Palette accelerator is pressed again", () => {
    openCommandPaletteWindow();
    const palette = created[0]!.win;

    dispatchMenuCommand({ kind: "commandPalette" });

    expect(palette.close).toHaveBeenCalledTimes(1);
    expect(palette.isDestroyed()).toBe(true);
  });

  test("keeps other menu commands on the focused renderer command stream", () => {
    const source = makeFocusedSource();
    focusedWindow = source;

    dispatchMenuCommand({ kind: "newConversation" });

    expect(created).toHaveLength(0);
    expect(source.webContents.send).toHaveBeenCalledWith("vellum:command", {
      kind: "newConversation",
    });
  });

  test("routes non-palette menu commands to the main window while the palette is focused", () => {
    openCommandPaletteWindow();
    const palette = created[0]!.win;

    dispatchMenuCommand({ kind: "openSettings" });

    expect(palette.webContents.send).not.toHaveBeenCalledWith(
      "vellum:command",
      { kind: "openSettings" },
    );
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "openSettings" });
  });
});
