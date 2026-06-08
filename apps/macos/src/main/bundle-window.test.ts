import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type WillNavigateListener = (event: { preventDefault: () => void }, url: string) => void;

interface StubWebContents {
  on: (event: string, listener: (...args: unknown[]) => void) => StubWebContents;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: "deny" | "allow" },
  ) => void;
  willNavigateListeners: WillNavigateListener[];
  windowOpenHandler: ((details: { url: string }) => { action: "deny" | "allow" }) | null;
}

interface StubWindow {
  focus: () => void;
  close: () => void;
  isDestroyed: () => boolean;
  on: (event: string, listener: () => void) => StubWindow;
  loadURL: (url: string) => Promise<void>;
  webContents: StubWebContents;
  emit: (event: string) => void;
  constructorOptions: Record<string, unknown>;
}

let constructed: StubWindow[] = [];
const focusMock = mock(() => undefined);
const closeMock = mock(() => undefined);
const loadURLMock = mock((_url: string) => Promise.resolve());

const makeWindow = (options: Record<string, unknown>): StubWindow => {
  const listeners = new Map<string, Array<() => void>>();
  const willNavigateListeners: WillNavigateListener[] = [];
  let destroyed = false;

  const webContents: StubWebContents = {
    on: (event, listener) => {
      if (event === "will-navigate") {
        willNavigateListeners.push(listener as WillNavigateListener);
      }
      return webContents;
    },
    setWindowOpenHandler: (handler) => {
      webContents.windowOpenHandler = handler;
    },
    willNavigateListeners,
    windowOpenHandler: null,
  };

  const win: StubWindow = {
    focus: focusMock,
    close: () => {
      closeMock();
      win.emit("closed");
    },
    isDestroyed: () => destroyed,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return win;
    },
    loadURL: loadURLMock,
    webContents,
    emit: (event) => {
      if (event === "closed") destroyed = true;
      for (const l of listeners.get(event) ?? []) l();
    },
    constructorOptions: options,
  };
  return win;
};

const sessionProtocolHandleMock = mock(
  (_scheme: string, _handler: unknown) => undefined,
);
const setPermissionRequestHandlerMock = mock(
  (_handler: unknown) => undefined,
);
const setPermissionCheckHandlerMock = mock(
  (_handler: unknown) => undefined,
);
const fromPartitionMock = mock(
  (_partition: string, _opts?: { cache: boolean }) => ({
    protocol: { handle: sessionProtocolHandleMock },
    setPermissionRequestHandler: setPermissionRequestHandlerMock,
    setPermissionCheckHandler: setPermissionCheckHandlerMock,
  }),
);

mock.module("electron", () => ({
  app: { isPackaged: false, getPath: () => "/fake/user-data" },
  session: { fromPartition: fromPartitionMock },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      const win = makeWindow(options);
      constructed.push(win);
      Object.assign(this, win);
    }
  },
}));

const createVellumAppHandlerMock = mock(
  (_bundlesRoot: string) => async (_req: Request) => new Response("ok"),
);

mock.module("./vellumapp-protocol", () => ({
  createVellumAppHandler: createVellumAppHandlerMock,
}));

const {
  openBundleWindow,
  closeBundleWindow,
  getOpenBundleWindows,
} = await import("./bundle-window");

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  constructed = [];
  focusMock.mockClear();
  closeMock.mockClear();
  loadURLMock.mockClear();
  fromPartitionMock.mockClear();
  sessionProtocolHandleMock.mockClear();
  setPermissionRequestHandlerMock.mockClear();
  setPermissionCheckHandlerMock.mockClear();
  createVellumAppHandlerMock.mockClear();
});

afterEach(() => {
  // Drain open windows so module-scope tracking resets between tests.
  for (const win of constructed) {
    if (!win.isDestroyed()) win.emit("closed");
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_2 = "11111111-2222-3333-4444-555555555555";

describe("openBundleWindow", () => {
  test("creates a window with the correct session partition", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");

    expect(constructed).toHaveLength(1);
    expect(fromPartitionMock).toHaveBeenCalledWith(`persist:bundle-${UUID}`, {
      cache: true,
    });

    const opts = constructed[0]!.constructorOptions;
    expect(opts.width).toBe(1024);
    expect(opts.height).toBe(768);
    expect(opts.title).toBe("Test Bundle");

    const prefs = opts.webPreferences as Record<string, unknown>;
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.preload).toBeUndefined();
  });

  test("denies all permission requests and checks on the bundle session", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");

    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandlerMock).toHaveBeenCalledTimes(1);

    const requestHandler = setPermissionRequestHandlerMock.mock.calls[0]![0] as (
      wc: unknown,
      perm: string,
      cb: (allowed: boolean) => void,
    ) => void;
    let granted = true;
    requestHandler({}, "media", (allowed) => { granted = allowed; });
    expect(granted).toBe(false);

    const checkHandler = setPermissionCheckHandlerMock.mock.calls[0]![0] as (
      ...args: unknown[]
    ) => boolean;
    expect(checkHandler({}, "clipboard-read", "vellumapp://example")).toBe(false);
  });

  test("registers the vellumapp:// handler on the bundle session", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    expect(sessionProtocolHandleMock).toHaveBeenCalledTimes(1);
    expect(sessionProtocolHandleMock.mock.calls[0]?.[0]).toBe("vellumapp");
  });

  test("loads the correct vellumapp:// URL", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    expect(loadURLMock).toHaveBeenCalledWith(`vellumapp://${UUID}/index.html`);
  });

  test("focuses the existing window when opening the same UUID twice", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    openBundleWindow(UUID, "index.html", "Test Bundle");

    expect(constructed).toHaveLength(1);
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  test("allows navigation within the same bundle", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    const win = constructed[0]!;

    const handler = win.webContents.willNavigateListeners[0]!;
    const preventDefault = mock(() => undefined);
    handler({ preventDefault }, `vellumapp://${UUID}/page2.html`);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("blocks navigation to a different UUID", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    const win = constructed[0]!;

    const handler = win.webContents.willNavigateListeners[0]!;
    const preventDefault = mock(() => undefined);
    handler({ preventDefault }, `vellumapp://${UUID_2}/index.html`);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("blocks navigation to external URLs", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    const win = constructed[0]!;

    const handler = win.webContents.willNavigateListeners[0]!;
    const preventDefault = mock(() => undefined);
    handler({ preventDefault }, "https://evil.com");
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("denies window.open", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    const win = constructed[0]!;
    expect(win.webContents.windowOpenHandler).not.toBeNull();
    expect(win.webContents.windowOpenHandler!({ url: "https://example.com" })).toEqual({
      action: "deny",
    });
  });
});

describe("closeBundleWindow", () => {
  test("closes and removes the window from tracking", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    expect(getOpenBundleWindows()).toEqual([UUID]);

    closeBundleWindow(UUID);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(getOpenBundleWindows()).toEqual([]);
  });

  test("is a no-op for an unknown UUID", () => {
    closeBundleWindow("nonexistent");
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe("getOpenBundleWindows", () => {
  test("returns list of open UUIDs", () => {
    openBundleWindow(UUID, "index.html", "Bundle A");
    openBundleWindow(UUID_2, "index.html", "Bundle B");

    expect(getOpenBundleWindows().sort()).toEqual([UUID, UUID_2].sort());
  });

  test("removes UUID when the window is closed", () => {
    openBundleWindow(UUID, "index.html", "Test Bundle");
    constructed[0]!.emit("closed");
    expect(getOpenBundleWindows()).toEqual([]);
  });
});
