import { mock } from "bun:test";

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    setName: () => undefined,
    setPath: () => undefined,
    getName: () => "Vellum",
    getVersion: () => "0.0.0",
    getPath: () => "/tmp",
    getAppPath: () => "/tmp",
    quit: () => undefined,
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
    webContents = {
      on: () => undefined,
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
    };
    on() {
      return this;
    }
    once() {
      return this;
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    show() {}
    focus() {}
  },
  ipcMain: {
    handle: () => undefined,
    on: () => undefined,
  },
  protocol: {
    handle: () => undefined,
    registerSchemesAsPrivileged: () => undefined,
  },
  net: {
    fetch: () => Promise.resolve(new Response("")),
  },
  shell: {
    openExternal: () => Promise.resolve(),
  },
}));
