import { beforeEach, describe, expect, mock, test } from "bun:test";

// Captures every `new BrowserWindow(...)` so assertions can inspect the
// sealed `webPreferences` the seam injects, and exposes the per-window
// `webContents` listener/handler registrations the navigation policy installs.
interface CapturedWindow {
  options: Record<string, unknown>;
  navigationListeners: Array<(event: { preventDefault: () => void }) => void>;
  windowOpenHandler: (() => { action: "deny" | "allow" }) | null;
}

let constructed: CapturedWindow[] = [];

// Mutable so individual tests can flip packaged/dev and re-import-free assert
// the `devTools` gate, mirroring how the real `app.isPackaged` differs between
// a dev run and a shipped build.
const appState = { isPackaged: false };
const DEBUG_DEVTOOLS_DEFINE = "__VELLUM_ENABLE_CHROME_DEVTOOLS__";

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      const captured: CapturedWindow = {
        options,
        navigationListeners: [],
        windowOpenHandler: null,
      };
      const webContents = {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "will-navigate") {
            captured.navigationListeners.push(
              listener as CapturedWindow["navigationListeners"][number],
            );
          }
          return webContents;
        },
        setWindowOpenHandler: (handler: () => { action: "deny" | "allow" }) => {
          captured.windowOpenHandler = handler;
        },
      };
      Object.assign(this, { webContents });
      constructed.push(captured);
    }
  },
}));

const { createWindow, hardenedWebPreferences } = await import("./windows");

beforeEach(() => {
  constructed = [];
  appState.isPackaged = false;
  delete (globalThis as Record<string, unknown>)[DEBUG_DEVTOOLS_DEFINE];
});

describe("hardenedWebPreferences", () => {
  test("sets the full hardened baseline and excludes preload", () => {
    const prefs = hardenedWebPreferences();
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    });
    // `preload` is role-specific and supplied by each caller, never by the
    // shared baseline.
    expect("preload" in prefs).toBe(false);
  });

  test("enables devTools in dev and disables it when packaged", () => {
    appState.isPackaged = false;
    expect(hardenedWebPreferences().devTools).toBe(true);
    appState.isPackaged = true;
    expect(hardenedWebPreferences().devTools).toBe(false);
  });

  test("enables devTools in a packaged debug build", () => {
    appState.isPackaged = true;
    (globalThis as Record<string, unknown>)[DEBUG_DEVTOOLS_DEFINE] = true;
    expect(hardenedWebPreferences().devTools).toBe(true);
  });
});

describe("createWindow", () => {
  test("seals the hardened webPreferences and wires the preload", () => {
    createWindow({ browserWindow: { width: 100 }, navigation: "deny-all" });

    expect(constructed).toHaveLength(1);
    const webPreferences = constructed[0]?.options.webPreferences as Record<
      string,
      unknown
    >;
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: true,
    });
    expect(webPreferences.preload).toContain("preload/index.js");
    // Caller-supplied window options pass through untouched.
    expect(constructed[0]?.options.width).toBe(100);
  });

  test("disables devTools on the window in a packaged build", () => {
    appState.isPackaged = true;
    createWindow({ browserWindow: {}, navigation: "deny-all" });
    const webPreferences = constructed[0]?.options.webPreferences as Record<
      string,
      unknown
    >;
    expect(webPreferences.devTools).toBe(false);
  });

  test("deny-all blocks top-level navigation and popups", () => {
    createWindow({ browserWindow: {}, navigation: "deny-all" });
    const win = constructed[0];

    let prevented = false;
    win?.navigationListeners.forEach((listener) =>
      listener({ preventDefault: () => (prevented = true) }),
    );
    expect(prevented).toBe(true);
    expect(win?.windowOpenHandler?.()).toEqual({ action: "deny" });
  });

  test("custom navigation delegates to the guard and installs no deny-all", () => {
    let guardedWindow: unknown = null;
    createWindow({
      browserWindow: {},
      navigation: { installGuard: (win) => (guardedWindow = win) },
    });
    const win = constructed[0];

    // The guard receives the constructed window…
    expect(guardedWindow).not.toBeNull();
    // …and the seam leaves navigation/window-open to that guard (and the
    // global `web-contents-created` handler) rather than denying outright.
    expect(win?.navigationListeners).toHaveLength(0);
    expect(win?.windowOpenHandler).toBeNull();
  });
});
