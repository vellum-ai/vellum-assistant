import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = () => void;

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string) => void;
};

type StubWindow = {
  webContents: StubWebContents;
  isDestroyed: () => boolean;
  on: (event: string, listener: Listener) => StubWindow;
  emit: (event: string) => void;
  setPosition: ReturnType<typeof mock>;
  setAlwaysOnTop: ReturnType<typeof mock>;
  setVisibleOnAllWorkspaces: ReturnType<typeof mock>;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  showInactive: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

const appState = { isPackaged: false };
const created: Array<{ opts: CreateWindowOptions; win: StubWindow }> = [];

const makeWindow = (): StubWindow => {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
  let webContentsDestroyed = false;
  const calls: string[] = [];

  const webContents: StubWebContents = {
    on: (event, listener) => {
      const listeners = webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      webContentsListeners.set(event, listeners);
      return webContents;
    },
    isDestroyed: () => webContentsDestroyed,
    emit: (event) => {
      if (event === "destroyed") webContentsDestroyed = true;
      for (const listener of webContentsListeners.get(event) ?? []) listener();
    },
  };

  const win: StubWindow = {
    webContents,
    isDestroyed: () => destroyed,
    on: (event, listener) => {
      const listeners = windowListeners.get(event) ?? [];
      listeners.push(listener);
      windowListeners.set(event, listeners);
      return win;
    },
    emit: (event) => {
      if (event === "closed") destroyed = true;
      for (const listener of windowListeners.get(event) ?? []) listener();
    },
    setPosition: mock((_x: number, _y: number) => undefined),
    setAlwaysOnTop: mock((_flag: boolean, _level: string) => undefined),
    setIgnoreMouseEvents: mock(
      (_ignore: boolean, _options?: { forward?: boolean }) => {
        calls.push("setIgnoreMouseEvents");
      },
    ),
    setVisibleOnAllWorkspaces: mock(
      (_visible: boolean, _opts: Record<string, boolean>) => undefined,
    ),
    show: mock(() => {
      calls.push("show");
    }),
    focus: mock(() => undefined),
    showInactive: mock(() => {
      calls.push("showInactive");
    }),
    loadURL: mock((_url: string) => Promise.resolve()),
  };
  Object.defineProperty(win, "__calls", { value: calls });
  return win;
};

const createWindowMock = mock((opts: CreateWindowOptions): StubWindow => {
  const win = makeWindow();
  created.push({ opts, win });
  return win;
});

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
}));

mock.module("./windows", () => ({
  createWindow: createWindowMock,
}));

const { createFloatingWindow, getFloatingWindow } = await import(
  "./floating-window"
);

let nextKind = 1;
const kind = (name: string): string => `${name}-${nextKind++}`;

beforeEach(() => {
  created.length = 0;
  createWindowMock.mockClear();
  appState.isPackaged = false;
  delete process.env.VELLUM_DEV_URL;
});

afterEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.emit("closed");
  }
});

describe("createFloatingWindow", () => {
  test("creates floating panels with the shared defaults and deny-all navigation", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:4242/assistant/";

    const win = createFloatingWindow({
      kind: kind("defaults"),
      route: "dictation-overlay",
      width: 480,
      height: 160,
    }) as unknown as StubWindow;

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    expect(created[0]?.opts.navigation).toBe("deny-all");
    expect(created[0]?.opts.browserWindow).toMatchObject({
      type: "panel",
      width: 480,
      height: 160,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
    });
    expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, "floating"]]);
    expect(win.setVisibleOnAllWorkspaces.mock.calls).toEqual([
      [
        true,
        {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        },
      ],
    ]);
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "http://localhost:4242/assistant/dictation-overlay",
    );
  });

  test("resolves packaged renderer routes under the assistant base", () => {
    appState.isPackaged = true;

    const win = createFloatingWindow({
      kind: kind("packaged-url"),
      route: "/command-palette",
      width: 320,
      height: 200,
    }) as unknown as StubWindow;

    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "app://vellum.ai/assistant/command-palette",
    );
  });

  test("uses showInactive unless focus is explicitly requested", () => {
    const passive = createFloatingWindow({
      kind: kind("passive"),
      route: "/passive",
      width: 100,
      height: 100,
      focusOnShow: false,
    }) as unknown as StubWindow;
    expect(passive.showInactive).toHaveBeenCalledTimes(1);
    expect(passive.show).not.toHaveBeenCalled();
    expect(passive.focus).not.toHaveBeenCalled();

    const focused = createFloatingWindow({
      kind: kind("focused"),
      route: "/focused",
      width: 100,
      height: 100,
      focusOnShow: true,
    }) as unknown as StubWindow;
    expect(focused.showInactive).not.toHaveBeenCalled();
    expect(focused.show).toHaveBeenCalledTimes(1);
    expect(focused.focus).toHaveBeenCalledTimes(1);
  });

  test("reuses the existing window for a kind and repositions it before showing", () => {
    let x = 10;
    const singletonKind = kind("singleton");
    const position = () => ({ x, y: x + 1 });

    const first = createFloatingWindow({
      kind: singletonKind,
      route: "/singleton",
      width: 100,
      height: 100,
      focusOnShow: true,
      position,
    }) as unknown as StubWindow;

    x = 20;
    const second = createFloatingWindow({
      kind: singletonKind,
      route: "/singleton",
      width: 100,
      height: 100,
      focusOnShow: true,
      position,
    }) as unknown as StubWindow;

    expect(second).toBe(first);
    expect(createWindowMock).toHaveBeenCalledTimes(1);
    expect(first.setPosition.mock.calls).toEqual([
      [10, 11],
      [20, 21],
    ]);
    expect(first.show).toHaveBeenCalledTimes(2);
    expect(first.focus).toHaveBeenCalledTimes(2);
    expect(first.loadURL).toHaveBeenCalledTimes(1);
  });

  test("allows callers to opt out of Spaces visibility and customize the top level", () => {
    const win = createFloatingWindow({
      kind: kind("spaces-opt-out"),
      route: "/overlay",
      width: 100,
      height: 100,
      visibleOnAllWorkspaces: false,
      alwaysOnTopLevel: "pop-up-menu",
    }) as unknown as StubWindow;

    expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, "pop-up-menu"]]);
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  test("applies click-through behavior before showing the window", () => {
    const win = createFloatingWindow({
      kind: kind("click-through"),
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: true,
    }) as unknown as StubWindow & { __calls: string[] };

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([[true]]);
    expect(win.__calls).toEqual(["setIgnoreMouseEvents", "showInactive"]);
  });

  test("can forward mouse movement while click-through", () => {
    const win = createFloatingWindow({
      kind: kind("click-through-forward"),
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    }) as unknown as StubWindow;

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([
      [true, { forward: true }],
    ]);
  });

  test("reapplies click-through behavior when reusing an existing window", () => {
    const singletonKind = kind("click-through-reuse");

    const win = createFloatingWindow({
      kind: singletonKind,
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    }) as unknown as StubWindow;
    win.setIgnoreMouseEvents.mockClear();

    createFloatingWindow({
      kind: singletonKind,
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    });

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([
      [true, { forward: true }],
    ]);
  });

  test("drops the singleton reference when the window closes", () => {
    const cleanupKind = kind("closed");
    const first = createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    }) as unknown as StubWindow;

    first.emit("closed");

    expect(getFloatingWindow(cleanupKind)).toBeNull();
    const second = createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    expect(second).not.toBe(first);
    expect(createWindowMock).toHaveBeenCalledTimes(2);
  });

  test("drops the singleton reference when webContents is destroyed", () => {
    const cleanupKind = kind("webcontents-destroyed");
    const first = createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    }) as unknown as StubWindow;

    first.webContents.emit("destroyed");

    expect(getFloatingWindow(cleanupKind)).toBeNull();
    const second = createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    expect(second).not.toBe(first);
    expect(createWindowMock).toHaveBeenCalledTimes(2);
  });
});
