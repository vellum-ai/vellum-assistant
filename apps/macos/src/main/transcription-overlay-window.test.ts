import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => void;

type Bounds = { x: number; y: number; width: number; height: number };

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string, ...args: unknown[]) => void;
  send: ReturnType<typeof mock>;
};

type StubWindow = {
  webContents: StubWebContents;
  isDestroyed: () => boolean;
  getBounds: () => Bounds;
  setBounds: (bounds: Partial<Bounds>) => void;
  on: (event: string, listener: Listener) => StubWindow;
  emit: (event: string, ...args: unknown[]) => void;
  setPosition: ReturnType<typeof mock>;
  setAlwaysOnTop: ReturnType<typeof mock>;
  setVisibleOnAllWorkspaces: ReturnType<typeof mock>;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
  show: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  showInactive: ReturnType<typeof mock>;
  hide: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

type HandlerFn = (args: unknown[]) => unknown;

const appState = { isPackaged: false };
const created: Array<{ opts: CreateWindowOptions; win: StubWindow }> = [];
const ipcHandlers = new Map<string, HandlerFn>();
let focusedWindow: { getBounds: () => Bounds; isDestroyed: () => boolean } | null =
  null;
let displayWorkArea: Bounds = { x: 0, y: 0, width: 1440, height: 900 };

const makeWindow = (): StubWindow => {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
  let webContentsDestroyed = false;
  let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };

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
    send: mock((_channel: string, _payload: unknown) => undefined),
  };

  const win: StubWindow = {
    webContents,
    isDestroyed: () => destroyed,
    getBounds: () => bounds,
    setBounds: (next) => {
      bounds = { ...bounds, ...next };
    },
    on: (event, listener) => {
      const listeners = windowListeners.get(event) ?? [];
      listeners.push(listener);
      windowListeners.set(event, listeners);
      return win;
    },
    emit: (event, ...args) => {
      if (event === "closed") destroyed = true;
      for (const listener of windowListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    setPosition: mock((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    }),
    setAlwaysOnTop: mock((_flag: boolean, _level: string) => undefined),
    setIgnoreMouseEvents: mock((_ignore: boolean) => undefined),
    setVisibleOnAllWorkspaces: mock(
      (_visible: boolean, _opts: Record<string, boolean>) => undefined,
    ),
    show: mock(() => undefined),
    focus: mock(() => undefined),
    showInactive: mock(() => undefined),
    hide: mock(() => undefined),
    loadURL: mock((_url: string) => Promise.resolve()),
  };

  return win;
};

const createWindowMock = mock((opts: CreateWindowOptions): StubWindow => {
  const win = makeWindow();
  win.setBounds({
    width: opts.browserWindow.width as number,
    height: opts.browserWindow.height as number,
  });
  created.push({ opts, win });
  return win;
});

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: class {
    static getFocusedWindow() {
      return focusedWindow;
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: displayWorkArea }),
    getDisplayMatching: () => ({ workArea: displayWorkArea }),
  },
}));

mock.module("./windows", () => ({
  createWindow: createWindowMock,
}));

mock.module("./ipc", () => ({
  handle: mock((channel: string, _schema: unknown, fn: unknown) => {
    ipcHandlers.set(channel, (args) => (fn as (args: unknown[]) => unknown)(args));
  }),
}));

const invoke = (channel: string, args: unknown[] = []): unknown => {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler(args);
};

const state = (overrides: Partial<{
  transcript: string;
  createdAt: number;
  autoDismissMs: number;
}> = {}) => ({
  transcript: "Hello from voice mode.",
  createdAt: 1_725_000_000_000,
  autoDismissMs: 0,
  ...overrides,
});

const { installTranscriptionOverlay } = await import(
  "./transcription-overlay-window"
);

installTranscriptionOverlay();

beforeEach(() => {
  invoke("vellum:transcriptionOverlay:dismiss");
  for (const { win } of created) {
    if (!win.isDestroyed()) {
      win.emit("closed");
    }
  }
  created.length = 0;
  createWindowMock.mockClear();
  appState.isPackaged = false;
  process.env.VELLUM_DEV_URL = "http://localhost:4242/assistant/";
  focusedWindow = null;
  displayWorkArea = { x: 0, y: 0, width: 1440, height: 900 };
});

afterEach(() => {
  invoke("vellum:transcriptionOverlay:dismiss");
  for (const { win } of created) {
    if (!win.isDestroyed()) {
      win.emit("closed");
    }
  }
});

describe("installTranscriptionOverlay", () => {
  test("creates a singleton floating transcription window on the standalone route", () => {
    invoke("vellum:transcriptionOverlay:show", [state()]);

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    const first = created[0]!;
    expect(first.opts.navigation).toBe("deny-all");
    expect(first.opts.browserWindow).toMatchObject({
      type: "panel",
      width: 520,
      height: 176,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
    });
    expect(first.win.setAlwaysOnTop.mock.calls).toEqual([[true, "floating"]]);
    expect(first.win.setVisibleOnAllWorkspaces.mock.calls).toEqual([
      [
        true,
        {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        },
      ],
    ]);
    expect(first.win.showInactive).toHaveBeenCalledTimes(1);
    expect(first.win.show).not.toHaveBeenCalled();
    expect(first.win.focus).not.toHaveBeenCalled();
    expect(first.win.loadURL.mock.calls[0]?.[0]).toBe(
      "http://localhost:4242/assistant/floating/transcription",
    );

    invoke("vellum:transcriptionOverlay:show", [
      state({ transcript: "A newer transcript." }),
    ]);

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    expect(first.win.showInactive).toHaveBeenCalledTimes(2);
    expect(first.win.loadURL).toHaveBeenCalledTimes(1);
    expect(first.win.webContents.send.mock.calls).toEqual([
      ["vellum:transcriptionOverlay:state", state()],
      [
        "vellum:transcriptionOverlay:state",
        state({ transcript: "A newer transcript." }),
      ],
    ]);

    first.win.emit("closed");
    invoke("vellum:transcriptionOverlay:show", [
      state({ transcript: "After close." }),
    ]);
    expect(createWindowMock).toHaveBeenCalledTimes(2);
    expect(created[1]?.win).not.toBe(first.win);
  });

  test("dismiss IPC and Escape both hide the active overlay and clear state", () => {
    invoke("vellum:transcriptionOverlay:show", [state()]);
    const win = created[0]!.win;

    expect(invoke("vellum:transcriptionOverlay:getState")).toEqual(state());

    invoke("vellum:transcriptionOverlay:dismiss");
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(invoke("vellum:transcriptionOverlay:getState")).toBeNull();

    invoke("vellum:transcriptionOverlay:show", [
      state({ transcript: "Dismiss with Escape." }),
    ]);
    const preventDefault = mock(() => undefined);
    win.webContents.emit("before-input-event", { preventDefault }, {
      type: "keyDown",
      key: "Escape",
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.hide).toHaveBeenCalledTimes(2);
    expect(invoke("vellum:transcriptionOverlay:getState")).toBeNull();
  });

  test("blur closes the active overlay", () => {
    invoke("vellum:transcriptionOverlay:show", [state()]);
    const win = created[0]!.win;

    win.emit("blur");

    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(invoke("vellum:transcriptionOverlay:getState")).toBeNull();
  });

  test("auto-dismiss hides the overlay after the state timeout", async () => {
    invoke("vellum:transcriptionOverlay:show", [
      state({ autoDismissMs: 1, transcript: "Temporary." }),
    ]);
    const win = created[0]!.win;

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(invoke("vellum:transcriptionOverlay:getState")).toBeNull();
  });

  test("positions bottom-center on the focused display, then reuses moved position", () => {
    displayWorkArea = { x: 1920, y: 40, width: 1280, height: 860 };
    focusedWindow = {
      getBounds: () => ({ x: 2100, y: 120, width: 800, height: 600 }),
      isDestroyed: () => false,
    };

    invoke("vellum:transcriptionOverlay:show", [state()]);
    const win = created[0]!.win;

    expect(win.setPosition.mock.calls[0]).toEqual([2300, 668]);

    win.setBounds({ x: 2345, y: 456 });
    win.emit("move");
    invoke("vellum:transcriptionOverlay:dismiss");
    invoke("vellum:transcriptionOverlay:show", [
      state({ transcript: "Back where the user left it." }),
    ]);

    expect(win.setPosition.mock.calls.at(-1)).toEqual([2345, 456]);
  });
});
