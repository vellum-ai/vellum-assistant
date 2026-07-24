import { mock } from "bun:test";

/**
 * Mock surface for `electron`. The real module is a native binary that
 * isn't loadable off-Electron, so `import { app, BrowserWindow, … } from
 * "electron"` would throw the moment any `src/main/` file is imported.
 *
 * The shim provides empty / no-op stubs covering every symbol currently
 * referenced under `src/main/`. Individual tests can re-mock specific
 * methods (e.g. `screen.getDisplayMatching`) via their own
 * `mock.module("electron", …)` call inside the test file.
 */
mock.module("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    setName: () => undefined,
    setAppUserModelId: () => undefined,
    setActivationPolicy: () => undefined,
    getPath: () => "/tmp",
    hide: () => undefined,
    isReady: () => false,
    quit: () => undefined,
    dock: undefined,
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
    webContents = { send: () => undefined };
    on() {
      return this;
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  },
  ipcMain: {
    handle: () => undefined,
    on: () => undefined,
  },
  dialog: {
    showErrorBox: () => undefined,
    showMessageBox: () =>
      Promise.resolve({ response: 0, checkboxChecked: false }),
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => undefined }),
    setApplicationMenu: () => undefined,
  },
  Tray: class {
    setIgnoreDoubleClickEvents() {}
    setToolTip() {}
    on() {
      return this;
    }
    popUpContextMenu() {}
    destroy() {}
  },
  nativeImage: {
    createFromBitmap: () => ({ setTemplateImage: () => undefined }),
    createFromPath: () => ({ setTemplateImage: () => undefined }),
  },
  protocol: {
    handle: () => undefined,
    registerSchemesAsPrivileged: () => undefined,
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: () => undefined },
      setPermissionRequestHandler: () => undefined,
      getPreloads: () => [],
      setPreloads: () => undefined,
    },
  },
  net: {
    // Import-time stub only — returns an empty Response so module-eval
    // calls succeed. Tests that exercise response bodies should re-mock
    // `net.fetch` locally with their own fixture.
    fetch: () => Promise.resolve(new Response("")),
  },
  safeStorage: {
    // Use no-op shims by default instead of touching keychain.
    // Re-mock `safeStorage` locally if needed for tests.
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (blob: Buffer) => blob.toString(),
  },
  screen: {
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
  shell: {
    openExternal: () => Promise.resolve(),
  },
  clipboard: {
    availableFormats: () => [],
    clear: () => undefined,
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readHTML: () => "",
    readImage: () => ({ isEmpty: () => true }),
    readRTF: () => "",
    readText: () => "",
    write: () => undefined,
    writeBuffer: () => undefined,
    writeText: () => undefined,
  },
}));
