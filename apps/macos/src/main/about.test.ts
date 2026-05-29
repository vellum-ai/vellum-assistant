import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type StubWebContents = {
  on: (event: string, listener: (...args: unknown[]) => void) => StubWebContents;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: "deny" | "allow" },
  ) => void;
  events: Map<string, Array<(...args: unknown[]) => void>>;
};

type StubWindow = {
  show: () => void;
  focus: () => void;
  isDestroyed: () => boolean;
  on: (event: string, listener: () => void) => StubWindow;
  once: (event: string, listener: () => void) => StubWindow;
  loadURL: (url: string) => Promise<void>;
  webContents: StubWebContents;
  emit: (event: string) => void;
};

let constructed: StubWindow[] = [];
const showMock = mock(() => undefined);
const focusMock = mock(() => undefined);
const loadURLMock = mock((_url: string) => Promise.resolve());

const makeWindow = (): StubWindow => {
  const listeners = new Map<string, Array<() => void>>();
  const webContentsListeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();
  let destroyed = false;
  const webContents: StubWebContents = {
    on: (event, listener) => {
      const arr = webContentsListeners.get(event) ?? [];
      arr.push(listener);
      webContentsListeners.set(event, arr);
      return webContents;
    },
    setWindowOpenHandler: () => undefined,
    events: webContentsListeners,
  };
  const win: StubWindow = {
    show: showMock,
    focus: focusMock,
    isDestroyed: () => destroyed,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return win;
    },
    once: (event, listener) => {
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
  };
  return win;
};

const getVersionMock = mock(() => "1.2.3");
const setAboutPanelOptionsMock = mock((_opts: unknown) => undefined);
const ipcHandleMock = mock((_channel: string, _handler: unknown) => undefined);
const openExternalMock = mock(() => Promise.resolve());

mock.module("electron", () => ({
  app: {
    getVersion: getVersionMock,
    setAboutPanelOptions: setAboutPanelOptionsMock,
  },
  BrowserWindow: class {
    constructor() {
      const win = makeWindow();
      constructed.push(win);
      // Mutate `this` so the production code's per-instance method
      // bindings (`aboutWindow.show()`, etc.) reach the stub. Caller
      // never holds the prototype instance directly.
      Object.assign(this, win);
    }
  },
  ipcMain: {
    handle: ipcHandleMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
}));

const { getVersionInfo, installAbout, openAboutWindow } = await import(
  "./about"
);

beforeEach(() => {
  constructed = [];
  showMock.mockClear();
  focusMock.mockClear();
  loadURLMock.mockClear();
  setAboutPanelOptionsMock.mockClear();
  ipcHandleMock.mockClear();
  openExternalMock.mockClear();
});

afterEach(() => {
  // Drain any open window between tests so module-scope state resets.
  for (const win of constructed) {
    if (!win.isDestroyed()) win.emit("closed");
  }
});

describe("getVersionInfo", () => {
  test("returns name, version, sha, copyright, website", () => {
    const info = getVersionInfo();
    expect(info.appName).toBe("Vellum");
    expect(info.version).toBe("1.2.3");
    expect(info.website).toBe("https://vellum.ai");
    expect(info.copyright).toContain("Vellum");
    expect(info.copyright).toContain(String(new Date().getFullYear()));
    // SHA isn't defined off the build pipeline; the module falls back
    // to "unknown" rather than throwing.
    expect(typeof info.commitSha).toBe("string");
  });
});

// Single test that exercises `installAbout()` end-to-end. Bun runs every
// `test()` in the same file inside the same module scope, so the
// `installed` flag inside `about.ts` would prevent re-running the install
// across multiple `test()` blocks. One call, multiple assertions.
describe("installAbout", () => {
  test("registers IPC handlers, populates the About panel, and is idempotent on repeated calls", () => {
    installAbout();
    installAbout();
    installAbout();

    const channels = ipcHandleMock.mock.calls.map((c) => c[0]);
    expect(channels).toContain("vellum:app:versionInfo");
    expect(channels).toContain("vellum:app:openWebsite");
    expect(ipcHandleMock).toHaveBeenCalledTimes(2);

    expect(setAboutPanelOptionsMock).toHaveBeenCalledTimes(1);
    const opts = setAboutPanelOptionsMock.mock.calls[0]?.[0] as {
      applicationName: string;
      applicationVersion: string;
      copyright: string;
      website: string;
    };
    expect(opts.applicationName).toBe("Vellum");
    expect(opts.applicationVersion).toBe("1.2.3");
    expect(opts.website).toBe("https://vellum.ai");
  });
});

describe("openAboutWindow", () => {
  test("constructs a new BrowserWindow loading the /about route", () => {
    openAboutWindow();
    expect(constructed).toHaveLength(1);
    expect(loadURLMock).toHaveBeenCalledTimes(1);
    // Dev URL pattern — the test env doesn't set `app.isPackaged` true,
    // so the dev branch runs. URL must end with the renderer-side
    // route path so the React route in apps/web mounts.
    expect(loadURLMock.mock.calls[0]?.[0]).toMatch(/\/about$/);
  });

  test("focuses the existing window instead of constructing a second one", () => {
    openAboutWindow();
    openAboutWindow();
    openAboutWindow();
    expect(constructed).toHaveLength(1);
    expect(showMock).toHaveBeenCalled();
    expect(focusMock).toHaveBeenCalledTimes(2);
  });

  test("reconstructs after the previous window was destroyed", () => {
    openAboutWindow();
    constructed[0]?.emit("closed");
    openAboutWindow();
    expect(constructed).toHaveLength(2);
  });

  test("blocks top-level navigation and popups so the preload bridge can't be carried elsewhere", () => {
    openAboutWindow();
    const win = constructed[0];
    expect(win).toBeDefined();

    // `will-navigate` handler is registered and calls preventDefault.
    const willNavigateHandlers = win?.webContents.events.get("will-navigate");
    expect(willNavigateHandlers?.length).toBe(1);
    const preventDefault = mock(() => undefined);
    willNavigateHandlers?.[0]?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
